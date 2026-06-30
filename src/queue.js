const { Queue, Worker, QueueEvents } = require("bullmq");

const QUEUE_NAME = "gmweb-send";

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
        priority: job.opts?.lifo ? "high" : "normal",
        attemptsMade: job.attemptsMade || 0,
        createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null
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
    const data = job.data;
    await job.remove();
    const fresh = await this.queue.add("send", data, { lifo: true });
    return { promoted: true, id: fresh.id, previousId: String(id), state: "waiting" };
  }

  // Remove a job from the queue (cancel a pending send).
  async removeJob(id) {
    const job = await this.queue.getJob(id);
    if (!job) return false;
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

  async close() {
    await this.worker?.close().catch(() => {});
    await this.events?.close().catch(() => {});
    await this.queue?.close().catch(() => {});
  }
}

module.exports = { SendQueue, QUEUE_NAME };
