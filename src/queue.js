const { Queue, Worker, QueueEvents } = require("bullmq");

const QUEUE_NAME = "gmweb-send";
const DEFERRED_HIGH_KEY = "gmweb-send:deferred-high";
const SUCCESS_SEQUENCE_KEY = "gmweb-send:success-sequence";
const HIGH_DEFER_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

// Shared Redis connection options. `maxRetriesPerRequest: null` is required by
// BullMQ for the blocking connections used by Worker and QueueEvents.
const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null
};

class SendQueue {
  constructor() {
    this.queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        // Keep recent history for the dashboard; auto-prune the rest.
        removeOnComplete: { age: 86400, count: 1000 },   // 1 day / 1000 jobs
        removeOnFail: { age: 604800, count: 1000 }         // 7 days / 1000 jobs
      }
    });
    this.events = new QueueEvents(QUEUE_NAME, { connection });
    this.worker = null;
  }

  enqueue(data, opts = {}) {
    return this.queue.add("send", data, opts);
  }

  async deferNormal(data, successes = 10) {
    const client = await this._redis();
    const sequence = Number(await client.get(SUCCESS_SEQUENCE_KEY)) || 0;
    const job = await this.enqueue({
      ...data,
      priority: "normal",
      deferCount: Number(data?.deferCount || 0) + 1
    }, {
      // Keep a real BullMQ job so the ledger and dashboard remain durable.
      delay: HIGH_DEFER_DELAY_MS
    });
    const releaseAt = sequence + Math.max(1, Number(successes) || 10);
    await client.zadd(DEFERRED_HIGH_KEY, releaseAt, String(job.id));
    return { job, releaseAt };
  }

  deferUntil(data, releaseAt, reason = "scheduled", { highPriority = false } = {}) {
    const releaseMs = releaseAt instanceof Date ? releaseAt.getTime() : Number(releaseAt);
    const delay = Math.max(1000, releaseMs - Date.now());
    return this.enqueue({
      ...data,
      priority: highPriority ? "high" : "normal",
      deferReason: reason,
      deferCount: Number(data?.deferCount || 0) + 1
    }, { delay, ...(highPriority ? { lifo: true } : {}) });
  }

  async deferHigh(data, successes = 10) {
    const client = await this._redis();
    const sequence = Number(await client.get(SUCCESS_SEQUENCE_KEY)) || 0;
    const job = await this.enqueue({
      ...data,
      priority: "high",
      deferCount: Number(data?.deferCount || 0) + 1
    }, {
      lifo: true,
      // Keep a real BullMQ job so the ledger and dashboard remain durable.
      // recordSuccessAndReleaseHigh promotes it after the success threshold.
      delay: HIGH_DEFER_DELAY_MS
    });
    const releaseAt = sequence + Math.max(1, Number(successes) || 10);
    await client.zadd(DEFERRED_HIGH_KEY, releaseAt, String(job.id));
    return { job, releaseAt };
  }

  async recordSuccessAndReleaseHigh() {
    const client = await this._redis();
    const sequence = Number(await client.incr(SUCCESS_SEQUENCE_KEY));

    // Check if there are any waiting jobs left.
    // BullMQ moves waiting jobs into its `paused` bucket while a queue is paused.
    // They are still pending sends, so we check both waiting and paused.
    const counts = await this.queue.getJobCounts("waiting", "paused");
    const waitingCount = (counts.waiting || 0) + (counts.paused || 0);

    let due;
    if (waitingCount === 0) {
      // If there are no waiting jobs, we release ALL deferred jobs because otherwise
      // they would be stuck forever waiting for a sequence increment that will never come!
      due = await client.zrange(DEFERRED_HIGH_KEY, 0, -1);
    } else {
      // Release at most one due deferred retry per progress step so a
      // group of deferred highs cannot form a new burst.
      due = await client.zrangebyscore(DEFERRED_HIGH_KEY, "-inf", sequence, "LIMIT", 0, 1);
    }

    if (!due.length) return { sequence, released: null };

    let promotedJob = null;
    for (const id of due) {
      try {
        const job = await this.queue.getJob(id);
        if (job) {
          const state = await job.getState().catch(() => "");
          if (state === "delayed") {
            await job.promote();
          }
          if (!promotedJob) {
            promotedJob = job;
          }
        }
      } catch (err) {
        // Safe catch
      }
      await client.zrem(DEFERRED_HIGH_KEY, id);

      // If there are waiting jobs, we only release one/first.
      if (waitingCount > 0) {
        break;
      }
    }

    return { sequence, released: promotedJob || null };
  }

  async forgetDeferredHigh(id) {
    const client = await this._redis();
    await client.zrem(DEFERRED_HIGH_KEY, String(id));
  }

  // --- Idempotency (dedupe POST /send retries) ---------------------------
  // Backed by the same Redis as the queue. A key reserves an in-flight send;
  // once enqueued we store the jobId so a retry returns the original job.
  async _redis() {
    return this.queue.client; // BullMQ resolves this to the ioredis connection
  }

  // Atomically reserve a key. Returns "OK" if newly reserved, null if it
  // already exists (a duplicate). Stored value starts as `pending:<hash>`.
  async reserveIdempotency(key, bodyHash, ttlSec = 86400) {
    const c = await this._redis();
    return c.set(`idem:${key}`, `pending:${bodyHash}`, "EX", ttlSec, "NX");
  }

  // Finalize a reserved key with the real jobId.
  async setIdempotencyJob(key, jobId, bodyHash, ttlSec = 86400) {
    const c = await this._redis();
    await c.set(`idem:${key}`, `${jobId}:${bodyHash}`, "EX", ttlSec);
  }

  // Returns { jobId|null, bodyHash, pending } for an existing key, or null.
  async getIdempotency(key) {
    const c = await this._redis();
    const val = await c.get(`idem:${key}`);
    if (!val) return null;
    if (val.startsWith("pending:")) return { jobId: null, bodyHash: val.slice(8), pending: true };
    const idx = val.lastIndexOf(":");
    return { jobId: val.slice(0, idx), bodyHash: val.slice(idx + 1), pending: false };
  }

  async releaseIdempotency(key) {
    const c = await this._redis();
    await c.del(`idem:${key}`).catch(() => {});
  }

  // --- Automatic content de-dupe ------------------------------------------
  // Suppresses an identical {to,text} re-sent within a short window even when
  // the caller forgot an Idempotency-Key (observed: a consumer double-POSTing
  // the same SMS seconds apart). Atomic SET NX reserves the content hash.
  async reserveDedupe(hash, ttlSec) {
    const c = await this._redis();
    return c.set(`dd:${hash}`, "pending", "EX", ttlSec, "NX"); // "OK" if new, null if dup
  }

  async setDedupeJob(hash, jobId, ttlSec) {
    const c = await this._redis();
    await c.set(`dd:${hash}`, String(jobId), "EX", ttlSec);
  }

  async getDedupe(hash) {
    const c = await this._redis();
    return c.get(`dd:${hash}`);
  }

  async releaseDedupe(hash) {
    const c = await this._redis();
    await c.del(`dd:${hash}`).catch(() => {});
  }

  getJob(id) {
    return this.queue.getJob(id);
  }

  async jobStatus(id) {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    const state = await job.getState();
    return {
      id: job.id,
      state,                                    // waiting | active | completed | failed | delayed
      to: job.data?.to,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts || 1,
      result: job.returnvalue || null,
      failedReason: job.failedReason || null,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null
    };
  }

  async counts() {
    const counts = await this.queue.getJobCounts("waiting", "paused", "active", "completed", "failed", "delayed");
    // BullMQ moves waiting jobs into its `paused` bucket while a queue is
    // paused. They are still pending sends, so expose waiting as the total
    // pending count; retain paused separately for diagnostics.
    return {
      ...counts,
      waiting: (counts.waiting || 0) + (counts.paused || 0)
    };
  }

  pause() {
    return this.queue.pause();
  }

  resume() {
    return this.queue.resume();
  }

  isPaused() {
    return this.queue.isPaused();
  }

  // List jobs (newest first) for the dashboard queue panel. Returns a light
  // shape — no full message body, just a preview.
  async listJobs({ states = ["active", "waiting", "paused", "delayed"], limit = 100 } = {}) {
    const jobs = await this.queue.getJobs(states, 0, Math.max(0, limit - 1), false);
    const out = [];
    for (const job of jobs) {
      if (!job) continue;
      const state = await job.getState().catch(() => "unknown");
      out.push({
        id: job.id,
        state,
        to: job.data?.to || null,
        textPreview: String(job.data?.text || "").replace(/\s+/g, " ").slice(0, 80),
        keyName: job.data?.keyName || null,
        priority: job.data?.priority === "high" || job.opts?.lifo ? "high" : "normal",
        attemptsMade: job.attemptsMade || 0,
        maxAttempts: job.opts?.attempts || 1,
        failedReason: job.failedReason || null,
        createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
        processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        delayUntil: job.delay ? new Date(job.timestamp + job.delay).toISOString() : null,
        deferReason: job.data?.deferReason || null,
        deferCount: Number(job.data?.deferCount || 0)
      });
    }
    return out;
  }

  // Internal-only full payloads used to migrate pre-ledger Redis backlog into
  // SQLite. Never return this shape directly from an HTTP route (it contains
  // complete message text and idempotency metadata).
  async pendingJobsForLedger(limit = 1000) {
    const jobs = await this.queue.getJobs(["active", "waiting", "paused", "delayed"], 0, Math.max(0, limit - 1), false);
    const out = [];
    for (const job of jobs) {
      if (!job) continue;
      out.push({
        jobId: String(job.id),
        state: await job.getState().catch(() => "waiting"),
        to: job.data?.to || "",
        text: job.data?.text || "",
        keyName: job.data?.keyName || null,
        priority: job.data?.priority === "high" || job.opts?.lifo ? "high" : "normal",
        idempotencyKey: job.data?._idempotencyKey || null,
        attempts: job.attemptsMade || 0,
        createdAt: job.timestamp || Date.now(),
        processedAt: job.processedOn || null,
        failedReason: job.failedReason || null
      });
    }
    return out;
  }

  // Bump a waiting/delayed job to the front of the line (processed next). The
  // worker pops from the tail, so re-adding with lifo puts it at the tail.
  // Returns the new job id, or null if the job is gone / already running.
  async promoteJob(id) {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    const state = await job.getState().catch(() => "unknown");
    if (state !== "waiting" && state !== "delayed") {
      return { promoted: false, reason: `job is ${state}`, state };
    }
    const data = { ...job.data, priority: "high" };
    // An explicit admin promotion means "send this next", even when the job
    // was previously delayed or is currently inside quiet hours.
    delete data.deferCount;
    delete data.deferReason;
    await this.forgetDeferredHigh(id);
    await job.remove();
    const fresh = await this.queue.add("send", data, { lifo: true });
    return { promoted: true, id: fresh.id, previousId: String(id), state: "waiting", _data: data };
  }

  // Release every HIGH job that has previously been deferred. The queue is
  // paused while jobs are reinserted so the worker cannot consume a partially
  // reordered batch. Reinsert newest-first: with BullMQ LIFO this leaves the
  // oldest deferred HIGH at the very front and preserves FIFO within the batch.
  async releaseDeferredHighJobs() {
    const wasPaused = await this.isPaused();
    if (!wasPaused) await this.pause();

    const released = [];
    try {
      const jobs = await this.queue.getJobs(["waiting", "paused", "delayed"], 0, -1, false);
      const candidates = [];
      for (const job of jobs) {
        if (!job) continue;
        const state = await job.getState().catch(() => "unknown");
        const high = job.data?.priority === "high" || Boolean(job.opts?.lifo);
        const wasDeferred = state === "delayed" ||
          Number(job.data?.deferCount || 0) > 0 ||
          Boolean(job.data?.deferReason);
        if (high && wasDeferred && ["waiting", "paused", "delayed"].includes(state)) {
          candidates.push({ job, state });
        }
      }

      candidates.sort((a, b) => Number(b.job.timestamp || 0) - Number(a.job.timestamp || 0));
      for (const { job } of candidates) {
        const data = { ...job.data, priority: "high" };
        // This admin action explicitly makes the next attempt immediate. Clear
        // deferral markers so quiet-hours logic treats it like a fresh HIGH;
        // a later failed attempt is still detected through attemptsMade.
        delete data.deferCount;
        delete data.deferReason;
        await this.forgetDeferredHigh(job.id);
        await job.remove();
        const fresh = await this.queue.add("send", data, { lifo: true });
        released.push({
          id: fresh.id,
          previousId: String(job.id),
          _data: data
        });
      }
    } finally {
      if (!wasPaused) await this.resume();
    }

    return released;
  }

  // Remove a job from the queue (cancel a pending send).
  async removeJob(id) {
    const job = await this.queue.getJob(id);
    if (!job) return false;
    await this.forgetDeferredHigh(id);
    await job.remove();
    return true;
  }

  // Block until a job finishes (used by /send?wait=true). Throws on failure/timeout.
  waitForJob(job, timeoutMs = 90000) {
    return job.waitUntilFinished(this.events, timeoutMs);
  }

  // Worker runs IN-PROCESS with concurrency 1 so it shares the single
  // Playwright browser instance. A separate worker process would need its
  // own browser and break the Google Messages session.
  startWorker(processor, handlers = {}, options = {}) {
    this.worker = new Worker(QUEUE_NAME, processor, {
      connection,
      ...options,
      concurrency: 1
    });
    if (handlers.onActive) this.worker.on("active", handlers.onActive);
    if (handlers.onCompleted) this.worker.on("completed", handlers.onCompleted);
    if (handlers.onFailed) this.worker.on("failed", handlers.onFailed);
    this.worker.on("error", (err) => { handlers.onError?.(err); });
    return this.worker;
  }

  async close({ force = false } = {}) {
    await this.worker?.close(force).catch(() => {});
    await this.events?.close().catch(() => {});
    await this.queue?.close().catch(() => {});
  }
}

module.exports = { SendQueue, QUEUE_NAME };
