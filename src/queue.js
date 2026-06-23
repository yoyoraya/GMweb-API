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

  counts() {
    return this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  }

  // Block until a job finishes (used by /send?wait=true). Throws on failure/timeout.
  waitForJob(job, timeoutMs = 90000) {
    return job.waitUntilFinished(this.events, timeoutMs);
  }

  // Worker runs IN-PROCESS with concurrency 1 so it shares the single
  // Playwright browser instance. A separate worker process would need its
  // own browser and break the Google Messages session.
  startWorker(processor, handlers = {}) {
    this.worker = new Worker(QUEUE_NAME, processor, {
      connection,
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
