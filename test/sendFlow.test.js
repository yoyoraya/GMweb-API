const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GoogleMessagesClient } = require("../src/googleMessagesClient");
const { SendQueue } = require("../src/queue");
const { SendStore } = require("../src/sendStore");

function client() {
  return new GoogleMessagesClient({
    sendMinIntervalMs: 1000,
    conversationHistoryMaxBatches: 2,
    conversationCacheFile: "./data/test-conversation-cache.json"
  });
}

test("send retries stay inside the SPA and defer after three UI misses", async () => {
  const c = client();
  assert(c.sendOperationTimeoutMs >= 220000);
  const attempts = [];
  let navigations = 0;
  const page = {
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    goto: async () => { navigations += 1; }
  };
  c.ensurePage = async () => page;
  c.ensurePaired = async () => {};
  c.openForSend = async (_to, _stage, options) => {
    attempts.push(options.restartNewConversation);
    return false;
  };

  await assert.rejects(
    c.sendMessageUnlocked({ to: "+989121234567", text: "hello" }),
    (error) => error.code === "CONVERSATION_OPEN_DEFER"
  );
  assert.deepEqual(attempts, [false, true, true]);
  assert.equal(navigations, 0);
});

test("a selected recipient without a composer is retried from Start chat", async () => {
  const c = client();
  let startChatClicks = 0;
  const stages = [];
  const input = {
    fill: async () => {},
    inputValue: async () => "+989121234567",
    press: async () => {},
    click: async () => {},
    type: async () => {}
  };
  c.ensurePage = async () => ({
    url: () => "https://messages.google.com/web/conversations/new",
    waitForTimeout: async () => {}
  });
  c.clickFirst = async () => { startChatClicks += 1; };
  c.locatorFirst = async () => input;
  c.clickRecipientOption = async () => "selected";

  const opened = await c.startChatFlow(
    "+989121234567",
    (stage) => stages.push(stage),
    { forceRestart: true }
  );
  assert.equal(opened, false);
  assert.equal(startChatClicks, 1);
  assert(stages.includes("restarting_start_chat"));
  assert(stages.includes("recipient_filled"));
});

test("normal misses go to the queue tail and high misses wait ten successes", async () => {
  const q = Object.create(SendQueue.prototype);
  const enqueued = [];
  const zadds = [];
  q.enqueue = async (data, opts = {}) => {
    const job = { id: String(enqueued.length + 1), data, opts };
    enqueued.push(job);
    return job;
  };
  q._redis = async () => ({
    get: async () => "7",
    zadd: async (...args) => { zadds.push(args); }
  });

  const normal = await q.deferNormal({ to: "1", text: "n" });
  const high = await q.deferHigh({ to: "2", text: "h" }, 10);
  assert.equal(normal.opts.lifo, undefined);
  assert.equal(normal.data.priority, "normal");
  assert.equal(high.job.opts.lifo, true);
  assert(high.job.opts.delay > 300 * 24 * 60 * 60 * 1000);
  assert.deepEqual(zadds[0], ["gmweb-send:deferred-high", 17, high.job.id]);
});

test("previous-year timestamps stop sidebar warm-up", () => {
  const c = client();
  assert.equal(c.timestampIsBeforeCurrentYear("Jun 30"), false);
  assert.equal(c.timestampIsBeforeCurrentYear(String(new Date().getFullYear() - 1)), true);
});

test("dashboard status refresh is single-flight and skipped during sidebar warm-up", async () => {
  const c = client();
  c.lastStatus = { paired: true };
  c.lastStatusAt = 0;
  let calls = 0;
  let release;
  c.status = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { paired: true };
  };

  c.sidebarIndexWarmPromise = Promise.resolve();
  await c.statusForDashboard({ maxAgeMs: 0 });
  assert.equal(calls, 0);

  c.sidebarIndexWarmPromise = null;
  await c.statusForDashboard({ maxAgeMs: 0 });
  await c.statusForDashboard({ maxAgeMs: 0 });
  assert.equal(calls, 1);
  release();
  await c.statusRefreshPromise;
});

test("browser lock timeout includes time spent waiting for the previous owner", async () => {
  const c = client();
  c.actionLock = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(
    c.withBrowserLock(async () => true, { timeoutMs: 30 }),
    /browser_lock_wait_timeout/
  );
  assert(Date.now() - started < 500);
});

test("idempotent sends receive a complete durable SQLite timeline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-send-store-"));
  const store = new SendStore(path.join(dir, "sends.db"));
  try {
    const id = store.create({
      to: "+989000000000", text: "test", keyName: "eve",
      priority: "high", idempotencyKey: "test-idem"
    });
    store.attachJob(id, "42");
    store.markStatus("42", "active", { attempts: 1 });
    store.markStage("42", "typing");
    const row = store.byJob("42");
    assert.equal(row.priority, "high");
    assert.equal(row.idempotency_key, "test-idem");
    assert.equal(row.status, "active");
    assert.equal(row.stage, "typing");
    assert(row.queued_at > 0);
    assert(row.active_at > 0);
    assert(row.stage_at > 0);
    assert.equal(store.backfillPending({
      jobId: "legacy-1", state: "waiting", to: "+989000000001", text: "legacy",
      keyName: "eve", priority: "normal", attempts: 1, createdAt: Date.now() - 5000
    }), true);
    const legacy = store.byJob("legacy-1");
    assert.equal(legacy.stage, "legacy_queued");
    assert.equal(legacy.status, "queued");
    assert.equal(store.backfillPending({ jobId: "legacy-1" }), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted conversation index skips expensive startup sidebar expansion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-index-"));
  const file = path.join(dir, "conversation-index.json");
  fs.writeFileSync(file, JSON.stringify([
    { href: "/web/conversations/abc", title: "Saved", text: "Saved", timestamp: "Jun 1" }
  ]));
  try {
    const c = new GoogleMessagesClient({
      sendMinIntervalMs: 1000,
      conversationHistoryMaxBatches: 80,
      conversationIndexMaxBatches: 6,
      conversationIndexBudgetMs: 45000,
      conversationCacheFile: path.join(dir, "recipient-cache.json"),
      conversationIndexFile: file
    });
    assert.equal(c.sidebarConversationIndex.size, 1);
    assert.equal(c.sidebarIndexReady, true);
    c.ensurePage = async () => { throw new Error("startup should not touch the page"); };
    const stats = await c.warmConversationIndex();
    assert.equal(stats.loadedFromDisk, true);
    assert.equal(stats.rows, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
