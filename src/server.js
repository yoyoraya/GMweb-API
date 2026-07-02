const Fastify = require("fastify");
const cors = require("@fastify/cors");
const proxy = require("@fastify/http-proxy");
const swagger = require("@fastify/swagger");
const swaggerUi = require("@fastify/swagger-ui");
const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { z } = require("zod");
const config = require("./config");
const { GoogleMessagesClient } = require("./googleMessagesClient");
const { ApiKeyStore } = require("./apiKeys");
const { SendQueue } = require("./queue");
const { SendStore } = require("./sendStore");
const { sendGate, DEFAULT_TIME_ZONE } = require("./sendSchedule");
const pkg = require("../package.json");

const app = Fastify({
  logger: true,
  trustProxy: true
});

const client = new GoogleMessagesClient(config);
const sseClients = new Set();
const apiKeyStore = new ApiKeyStore(
  path.join(config.rootDir, "data", "api-keys.json"),
  path.join(config.rootDir, "data", "api-requests.jsonl")
);
const sendQueue = new SendQueue();
// Durable send ledger — survives crashes, tracks per-message status, powers the
// 24h de-dupe, and lets us rebuild the queue from disk if Redis is ever wiped.
const sendStore = new SendStore(path.join(config.rootDir, "data", "sends.db"));
const dashboardSessionCookieName = "gmweb_session";
const dashboardPasswordCookieName = "gmweb_login";
const dashboardDir = path.join(config.rootDir, "public", "dashboard");
const spaDir = path.join(config.rootDir, "public", "dashboard-next");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
const rateBuckets = new Map();
const dashboardSessions = new Map();
const dashboardPasswordSessions = new Map();
const sessionsFile = path.join(config.rootDir, "data", "dashboard-sessions.json");
const browserHealthFile = process.env.BROWSER_HEALTH_FILE || "/var/lib/gmweb/browser-health.json";

function readCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

let previousCpuTimes = readCpuTimes();

async function readSystemMetrics() {
  const current = readCpuTimes();
  const totalDelta = current.total - previousCpuTimes.total;
  const idleDelta = current.idle - previousCpuTimes.idle;
  previousCpuTimes = current;

  let totalBytes = os.totalmem();
  let availableBytes = os.freemem();
  let swapTotalBytes = 0;
  let swapFreeBytes = 0;
  if (process.platform === "linux") {
    try {
      const meminfo = await fs.readFile("/proc/meminfo", "utf8");
      const values = Object.fromEntries([...meminfo.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
      totalBytes = values.MemTotal || totalBytes;
      availableBytes = values.MemAvailable || availableBytes;
      swapTotalBytes = values.SwapTotal || 0;
      swapFreeBytes = values.SwapFree || 0;
    } catch { /* os values remain available */ }
  }

  const cores = os.cpus().length;
  const load = os.loadavg();
  return {
    cpu: {
      cores,
      usagePercent: totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0,
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
      loadPercent: cores ? Math.round((load[0] / cores) * 1000) / 10 : 0
    },
    memory: {
      totalBytes,
      availableBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      usagePercent: totalBytes ? Math.round((1 - availableBytes / totalBytes) * 1000) / 10 : 0
    },
    swap: {
      totalBytes: swapTotalBytes,
      usedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
      usagePercent: swapTotalBytes ? Math.round((1 - swapFreeBytes / swapTotalBytes) * 1000) / 10 : 0
    },
    uptimeSeconds: Math.floor(os.uptime())
  };
}

async function loadSessions() {
  try {
    const text = await fs.readFile(sessionsFile, "utf8");
    const saved = JSON.parse(text);
    const now = Date.now();
    for (const [id, session] of Object.entries(saved || {})) {
      if (session.expiresAt > now) dashboardSessions.set(id, session);
    }
  } catch { /* first run or missing file */ }
}

function saveSessions() {
  const obj = Object.fromEntries(dashboardSessions);
  fs.writeFile(sessionsFile, JSON.stringify(obj), "utf8").catch(() => {});
}
const dummyDashboardPasswordHash = "scrypt$v1$16384$8$1$aHInyzzd-xELadFCqewEOXskJ5E-EUJY$UUWVXTBwmOEPmu1yAIiq1mCAOTKFLv_WmAfqYSRzd8zlOtaUNx3KcADlnh6r5UWxbfoALvpmBxeTF7ELK9hITA";

function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (!config.corsOrigins.length) return callback(null, true);
  callback(null, config.corsOrigins.includes(origin));
}

function applySecurityHeaders(request, reply, done) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "SAMEORIGIN");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("cross-origin-resource-policy", "same-origin");
  if (!requestPath(request.url).startsWith("/vnc")) {
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
    );
  }
  if (config.dashboardCookieSecure) {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  done();
}

function checkRateLimit(request, key, max, windowMs) {
  const now = Date.now();
  const bucketKey = `${key}:${request.ip || request.socket?.remoteAddress || "unknown"}`;
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
  }
  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);
  return {
    allowed: bucket.count <= max,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

function passwordAuthEnabled() {
  return Boolean(config.dashboardUsername && config.dashboardPasswordHash);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function userAgentHash(request) {
  return crypto
    .createHash("sha256")
    .update(String(request.headers["user-agent"] || ""))
    .digest("base64url");
}

function cleanupDashboardSessions() {
  const now = Date.now();
  for (const [sessionId, session] of dashboardSessions) {
    if (session.expiresAt <= now) dashboardSessions.delete(sessionId);
  }
  for (const [sessionId, session] of dashboardPasswordSessions) {
    if (session.expiresAt <= now) dashboardPasswordSessions.delete(sessionId);
  }
}

function createDashboardSession(request) {
  cleanupDashboardSessions();
  const sessionId = randomToken(32);
  const csrfToken = randomToken(32);
  const now = Date.now();
  dashboardSessions.set(sessionId, {
    csrfToken,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + config.dashboardSessionTtlMs,
    userAgentHash: userAgentHash(request)
  });
  saveSessions();
  return { sessionId, csrfToken };
}

function createDashboardPasswordSession(request) {
  cleanupDashboardSessions();
  const sessionId = randomToken(32);
  const now = Date.now();
  dashboardPasswordSessions.set(sessionId, {
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + config.dashboardPasswordSessionTtlMs,
    userAgentHash: userAgentHash(request)
  });
  return { sessionId };
}

function dashboardSession(request) {
  const sessionId = parseCookies(request.headers.cookie)[dashboardSessionCookieName] || "";
  if (!sessionId) return null;
  const session = dashboardSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    dashboardSessions.delete(sessionId);
    return null;
  }
  if (config.dashboardBindUserAgent && session.userAgentHash !== userAgentHash(request)) {
    dashboardSessions.delete(sessionId);
    return null;
  }
  session.lastSeenAt = Date.now();
  return { sessionId, ...session };
}

function dashboardPasswordSession(request) {
  if (!passwordAuthEnabled()) return { bypass: true };
  const sessionId = parseCookies(request.headers.cookie)[dashboardPasswordCookieName] || "";
  if (!sessionId) return null;
  const session = dashboardPasswordSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    dashboardPasswordSessions.delete(sessionId);
    return null;
  }
  if (config.dashboardBindUserAgent && session.userAgentHash !== userAgentHash(request)) {
    dashboardPasswordSessions.delete(sessionId);
    return null;
  }
  session.lastSeenAt = Date.now();
  return { sessionId, ...session };
}

function clearDashboardSession(request) {
  const sessionId = parseCookies(request.headers.cookie)[dashboardSessionCookieName] || "";
  if (sessionId) dashboardSessions.delete(sessionId);
  const passwordSessionId = parseCookies(request.headers.cookie)[dashboardPasswordCookieName] || "";
  if (passwordSessionId) dashboardPasswordSessions.delete(passwordSessionId);
  saveSessions();
}

function parsePasswordHash(hash) {
  const [scheme, version, n, r, p, salt, derived] = String(hash || "").split("$");
  if (scheme !== "scrypt" || version !== "v1" || !salt || !derived) return null;
  return {
    n: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    salt,
    derived
  };
}

function safeStringEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a || "")).digest();
  const right = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(left, right);
}

function verifyDashboardPassword(password, hash = config.dashboardPasswordHash) {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const expected = Buffer.from(parsed.derived, "base64url");
  const actual = crypto.scryptSync(String(password || ""), parsed.salt, expected.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: 64 * 1024 * 1024
  });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function sameOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  const proto = request.headers["x-forwarded-proto"] || request.protocol || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return origin === `${proto}://${host}`;
}

function csrfAllowed(request, session) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (!sameOriginAllowed(request)) return false;
  return request.headers["x-csrf-token"] === session.csrfToken;
}

function requestPath(url) {
  return String(url || "").split("?")[0] || "/";
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function bearerToken(request) {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function hasDashboardAccess(request) {
  if (!config.apiToken) return true;
  return Boolean(dashboardSession(request)) || bearerToken(request) === config.apiToken;
}

function isDashboardAsset(requestUrl) {
  const pathname = requestPath(requestUrl);
  return pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/" ||
    pathname === "/dashboard/password-login" || pathname === "/dashboard/login" ||
    pathname === "/dashboard/logout" || pathname === "/dashboard/session" ||
    pathname.startsWith("/dashboard/") ||
    // New React console (Vite SPA) served as static assets under /app.
    pathname === "/app" || pathname.startsWith("/app/");
}

// Routes only accessible by master token or dashboard session (not project keys)
const ADMIN_ONLY_PREFIXES = ["/admin/", "/browser/", "/session/", "/dashboard/", "/vnc", "/docs"];

function isAdminOnlyPath(url) {
  const p = requestPath(url);
  return ADMIN_ONLY_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// Brute-force protection: track auth failures per IP
const authFailBuckets = new Map();
const AUTH_FAIL_MAX = 20;        // max failed auth attempts
const AUTH_FAIL_WINDOW = 600_000; // per 10 minutes
const AUTH_BLOCK_DURATION = 1800_000; // 30-minute block after repeated failures

function isAuthBlocked(ip) {
  const bucket = authFailBuckets.get(ip);
  if (!bucket) return false;
  const now = Date.now();
  if (bucket.blockedUntil && now < bucket.blockedUntil) return true;
  // Reset expired window
  bucket.attempts = bucket.attempts.filter((ts) => now - ts < AUTH_FAIL_WINDOW);
  if (bucket.attempts.length >= AUTH_FAIL_MAX) {
    bucket.blockedUntil = now + AUTH_BLOCK_DURATION;
    bucket.attempts = [];
    return true;
  }
  return false;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  let bucket = authFailBuckets.get(ip);
  if (!bucket) { bucket = { attempts: [], blockedUntil: 0 }; authFailBuckets.set(ip, bucket); }
  bucket.attempts.push(now);
}

function requireToken(request, reply, done) {
  if (config.publicHealth && request.url === "/health") return done();
  if (config.dashboardEnabled && isDashboardAsset(request.url)) return done();
  if (config.dashboardEnabled && requestPath(request.url).startsWith("/vnc")) {
    if (hasDashboardAccess(request)) return done();
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  if (!config.apiToken) return done();

  const ip = request.ip || "";

  // Brute-force block check
  if (isAuthBlocked(ip)) {
    reply.code(429).send({ error: "too_many_auth_failures", retryAfterSeconds: Math.ceil(AUTH_BLOCK_DURATION / 1000) });
    return;
  }

  // Master token — full access (constant-time compare)
  const token = bearerToken(request);
  if (token) {
    const masterHash = crypto.createHash("sha256").update(config.apiToken).digest();
    const tokenHash  = crypto.createHash("sha256").update(token).digest();
    if (masterHash.length === tokenHash.length && crypto.timingSafeEqual(masterHash, tokenHash)) {
      return done();
    }
  }

  // Dashboard session — full access
  const session = dashboardSession(request);
  if (session && csrfAllowed(request, session)) return done();
  if (session) {
    reply.code(403).send({ error: "csrf_failed" });
    return;
  }

  // Project API key — only for non-admin paths
  if (!isAdminOnlyPath(request.url) && token) {
    const key = apiKeyStore.findByToken(token);
    if (key) {
      if (!apiKeyStore.isIpAllowed(key, ip)) {
        recordAuthFailure(ip); // wrong IP for a valid-format token
        reply.code(403).send({ error: "ip_not_allowed", ip });
        return;
      }
      request._projectKey = key;
      apiKeyStore.recordUse(key.id);
      apiKeyStore.appendLog({
        ts: new Date().toISOString(),
        keyId: key.id,
        keyName: key.name,
        ip,
        method: request.method,
        path: requestPath(request.url),
        count: key.requestCount
      }).catch(() => {});
      return done();
    }
  }

  // Only count as brute-force when a token was actually provided but wrong.
  // Missing auth (browser hitting /docs assets, dashboard session expired) is NOT brute force.
  if (token) recordAuthFailure(ip);
  reply.code(401).send({ error: "unauthorized" });
}

function emitSse(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const reply of sseClients) {
    reply.raw.write(payload);
  }
}

async function postWebhook(event) {
  if (!config.webhookUrl) return;
  try {
    await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
  } catch (error) {
    app.log.warn({ error }, "webhook post failed");
  }
}

client.on("conversation:changed", (event) => {
  emitSse(event);
  postWebhook(event);
});
client.on("session:claimed", (event) => {
  app.log.warn({ at: event.at }, "Google Messages requested this web session; selected Use here automatically");
  emitSse({ type: "browser_session_claimed", at: event.at });
});
// Note: message send lifecycle SSE/webhooks are emitted by the queue worker
// (with jobId), so we no longer mirror client's internal "message:sent" here.
client.on("error", (error) => app.log.warn({ error }, "client error"));

// Queue worker: processes one send at a time using the shared browser.
// Hard per-send timeout so a wedged page can never stall the queue, plus
// auto-recovery (reconnect + fresh page) after consecutive failures.
// The UI flow intentionally gets up to three attempts. Preserve that contract
// even on installations carrying the old 80-second environment default.
const SEND_TIMEOUT_MS = Math.max(240000, Number(config.sendTimeoutMs) || 240000);
// Durable de-dupe window: an identical {to,text} already SENT within this many
// hours (or still in flight) is suppressed — even with no Idempotency-Key, and
// even across restarts (backed by the SQLite ledger). Default 24h.
const SEND_DEDUPE_MS = (Number(process.env.SEND_DEDUPE_HOURS) || 24) * 3600 * 1000;
const SEND_FAIL_RESTART_THRESHOLD = Number(process.env.SEND_FAIL_RESTART_THRESHOLD) || 3;
// client.recover() only drops Playwright's reference and reconnects — it
// fixes a wedged *page*, but does nothing if the Chrome *process* itself is
// too resource-starved to service a new CDP connection (connectOverCDP just
// times out again, identically, on every job). If a soft recover doesn't
// stop the failures within one more full streak, escalate to the same
// process-level restart the "restart-chrome" admin action performs.
const SEND_HARD_RESTART_THRESHOLD = Number(process.env.SEND_HARD_RESTART_THRESHOLD) || 2;
const HARD_RESTART_COOLDOWN_MS = Number(process.env.HARD_RESTART_COOLDOWN_MS) || 5 * 60 * 1000;
const browserRecoveryFile = path.join(config.rootDir, "data", "browser-recovery.json");
// Deliberately conservative pacing for browser-driven sends. The minimum gap
// prevents bursts; BullMQ's limiter also caps starts across a full minute.
const SEND_MIN_INTERVAL_MS = Math.max(1000, Number(process.env.SEND_MIN_INTERVAL_MS) || 15000);
const SEND_MAX_PER_MINUTE = Math.max(1, Number(process.env.SEND_MAX_PER_MINUTE) || 4);
const SEND_TIME_ZONE = process.env.SEND_TIMEZONE || DEFAULT_TIME_ZONE;
const SEND_QUIET_START_HOUR = Number(process.env.SEND_QUIET_START_HOUR ?? 2);
const SEND_QUIET_END_HOUR = Number(process.env.SEND_QUIET_END_HOUR ?? 8);
let sendFailStreak = 0;
let recovering = false;
let recoverEscalations = 0;
let lastHardRestartAt = 0;
let lastSendStartedAt = 0;
let hardRecoveryScheduled = false;

function isBrowserAutomationWedge(error) {
  const text = String(error?.message || error || "");
  return /send_timeout|browser_lock_.*timeout|connectOverCDP.*Timeout|Target page.*closed/i.test(text);
}

async function scheduleHardBrowserRecovery(reason, jobId) {
  if (hardRecoveryScheduled || process.platform === "win32") return false;
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(browserRecoveryFile, "utf8")); } catch { /* first recovery */ }
  if (Date.now() - Number(previous.at || 0) < HARD_RESTART_COOLDOWN_MS) return false;

  hardRecoveryScheduled = true;
  const record = { at: Date.now(), reason: String(reason || "browser_unresponsive"), jobId: String(jobId || "") };
  await fs.writeFile(browserRecoveryFile, JSON.stringify(record, null, 2), "utf8").catch(() => {});
  app.log.error({ reason: record.reason, jobId: record.jobId }, "browser automation wedged; scheduling hard recovery");
  emitSse({ type: "browser_hard_restart", reason: record.reason, jobId: record.jobId, at: new Date().toISOString() });
  scheduleSystemctl(["restart", "gmweb-chrome.service"]);
  setTimeout(() => scheduleSystemctl(["restart", "gmweb-api.service"]), 2500);
  return true;
}

async function waitForSendPace(job) {
  const waitMs = Math.max(0, lastSendStartedAt + SEND_MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) {
    sendStore.markStage(job.id, "pacing");
    emitSse({ type: "send_stage", jobId: job.id, to: job.data?.to, stage: "pacing", waitMs, at: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastSendStartedAt = Date.now();
}

function isHighPriorityJob(job) {
  return job?.data?.priority === "high" || Boolean(job?.opts?.lifo);
}

function isDelayedRetryJob(job) {
  return Number(job?.attemptsMade || 0) > 0 ||
    Number(job?.opts?.delay || job?.delay || 0) > 0 ||
    Number(job?.data?.deferCount || 0) > 0 ||
    Boolean(job?.data?.deferReason);
}

async function deferQuietHoursJob(job, releaseAt) {
  const high = isHighPriorityJob(job);
  const ledger = sendStore.byJob(job.id);
  const data = {
    ...job.data,
    priority: high ? "high" : "normal",
    _ledgerId: ledger?.id || job.data?._ledgerId || null
  };
  const releaseIso = releaseAt.toISOString();
  sendStore.markStatus(job.id, "queued", { attempts: job.attemptsMade || 0 });
  sendStore.markStage(job.id, "quiet_hours");

  const deferredJob = await sendQueue.deferUntil(data, releaseAt, "quiet_hours", { highPriority: high });
  if (data._ledgerId) sendStore.attachJob(data._ledgerId, deferredJob.id);
  if (data._idempotencyKey && data._bodyHash) {
    await sendQueue.setIdempotencyJob(data._idempotencyKey, deferredJob.id, data._bodyHash).catch(() => {});
  }

  const event = {
    type: "send_deferred",
    reason: "quiet_hours",
    jobId: job.id,
    deferredJobId: deferredJob.id,
    to: job.data?.to,
    priority: high ? "high" : "normal",
    timeZone: SEND_TIME_ZONE,
    releaseAt: releaseIso,
    at: new Date().toISOString()
  };
  emitSse(event);
  return { deferred: true, ...event };
}

async function deferConversationJob(job, error) {
  const high = isHighPriorityJob(job);
  const ledger = sendStore.byJob(job.id);
  const data = {
    ...job.data,
    priority: high ? "high" : "normal",
    _ledgerId: ledger?.id || job.data?._ledgerId || null
  };
  sendStore.markStatus(job.id, "queued", {
    attempts: job.attemptsMade || 0,
    error: error.message
  });

  const deferred = high
    ? await sendQueue.deferHigh(data, 10)
    : await sendQueue.deferNormal(data, 10);
  if (data._ledgerId) sendStore.attachJob(data._ledgerId, deferred.job.id);
  if (data._idempotencyKey && data._bodyHash) {
    await sendQueue.setIdempotencyJob(data._idempotencyKey, deferred.job.id, data._bodyHash).catch(() => {});
  }

  const event = {
    type: "send_deferred",
    jobId: job.id,
    deferredJobId: deferred.job.id,
    to: job.data?.to,
    priority: high ? "high" : "normal",
    releaseAfterSuccesses: 10,
    at: new Date().toISOString()
  };
  emitSse(event);
  return { deferred: true, ...event };
}

async function handleSendCompleted(job, result) {
  if (result?.deferred) return;
  sendStore.markStatus(job.id, "sent", { attempts: job.attemptsMade || 0 });
  const event = {
    type: "send_completed",
    jobId: job.id,
    to: job.data?.to,
    text: job.data?.text,
    fastPath: result?.fastPath,
    at: result?.at || new Date().toISOString()
  };
  emitSse(event);
  postWebhook(event);

  const release = await sendQueue.recordSuccessAndReleaseHigh();
  if (release.released) {
    emitSse({
      type: "send_deferred_released",
      jobId: release.released.id,
      to: release.released.data?.to,
      successSequence: release.sequence,
      at: new Date().toISOString()
    });
  }
}

function startSendWorker() {
  sendQueue.startWorker(
    async (job) => {
      // Runs in-process; shares the single Playwright browser via withBrowserLock.
      const schedule = sendGate(new Date(), {
        highPriority: isHighPriorityJob(job),
        delayedRetry: isDelayedRetryJob(job),
        timeZone: SEND_TIME_ZONE,
        startHour: SEND_QUIET_START_HOUR,
        endHour: SEND_QUIET_END_HOUR
      });
      if (schedule.blocked) return deferQuietHoursJob(job, schedule.releaseAt);
      await waitForSendPace(job);
      try {
        const result = await Promise.race([
          client.sendMessage({
            to: job.data.to,
            text: job.data.text,
            // Per-message progress: record the stage in the ledger and stream it.
            onStage: (s) => {
              sendStore.markStage(job.id, s);
              emitSse({ type: "send_stage", jobId: job.id, to: job.data?.to, stage: s, at: new Date().toISOString() });
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("send_timeout")), SEND_TIMEOUT_MS))
        ]);
        sendFailStreak = 0; // a success clears the streak
        recoverEscalations = 0; // and proves the browser is genuinely healthy again
        return result;
      } catch (error) {
        if (isBrowserAutomationWedge(error)) {
          sendStore.markStage(job.id, "browser_unresponsive");
          await scheduleHardBrowserRecovery(error.message, job.id);
        }
        if (error?.code === "GOOGLE_CONVERSATION_RATE_LIMIT") {
          await sendQueue.pause();
          app.log.warn("send queue auto-paused after Google limited new conversations");
          emitSse({
            type: "queue_paused",
            reason: "google_conversation_rate_limit",
            at: new Date().toISOString()
          });
        }
        if (error?.code === "CONVERSATION_OPEN_DEFER") {
          return deferConversationJob(job, error);
        }
        throw error;
      }
    },
    {
      onActive: (job) => {
        sendStore.markStatus(job.id, "active", { attempts: job.attemptsMade || 0 });
        emitSse({
          type: "send_processing",
          jobId: job.id,
          to: job.data?.to,
          at: new Date().toISOString()
        });
      },
      onCompleted: (job, result) => {
        handleSendCompleted(job, result)
          .catch((error) => app.log.warn({ error }, "send completion bookkeeping failed"));
      },
      onFailed: (job, err) => {
        const attemptsMade = job?.attemptsMade || 0;
        const maxAttempts = job?.opts?.attempts || 1;
        const willRetry = attemptsMade < maxAttempts;
        // While BullMQ still has retries left the job goes back to waiting, so
        // keep the ledger row 'queued'; only mark 'failed' once it's terminal.
        sendStore.markStatus(job?.id, willRetry ? "queued" : "failed", {
          attempts: attemptsMade,
          error: err?.message || "send failed"
        });
        const event = {
          type: "send_failed",
          jobId: job?.id,
          to: job?.data?.to,
          error: err?.message || "send failed",
          attemptsMade,
          willRetry,
          at: new Date().toISOString()
        };
        emitSse(event);
        postWebhook(event);

        // Auto-recover the browser after repeated failures (likely a wedged
        // page). Reconnects and loads a fresh Messages page without killing
        // the external Chrome. Only counts terminal failures (no more retries).
        if (!willRetry) {
          sendFailStreak += 1;

          sendQueue.recordSuccessAndReleaseHigh()
            .then((release) => {
              if (release.released) {
                emitSse({
                  type: "send_deferred_released",
                  jobId: release.released.id,
                  to: release.released.data?.to,
                  successSequence: release.sequence,
                  at: new Date().toISOString()
                });
              }
            })
            .catch((error) => app.log.warn({ error }, "failed send deferred release bookkeeping failed"));
        }
        if (sendFailStreak >= SEND_FAIL_RESTART_THRESHOLD && !recovering) {
          recovering = true;
          sendFailStreak = 0;
          recoverEscalations += 1;

          // A soft recover already failed to clear a full streak once before —
          // reconnecting Playwright's reference isn't enough (seen in
          // production: every job failing identically on
          // "connectOverCDP: Timeout 30000ms exceeded" while the CDP port
          // still answered plain HTTP pings, i.e. Chrome itself was too
          // starved to service a new automation session). Escalate to a real
          // process restart, the same action "restart-chrome" performs.
          const hardRestartDue = recoverEscalations >= SEND_HARD_RESTART_THRESHOLD &&
            Date.now() - lastHardRestartAt > HARD_RESTART_COOLDOWN_MS;

          if (hardRestartDue) {
            lastHardRestartAt = Date.now();
            recoverEscalations = 0;
            app.log.warn("hard-restarting Chrome after repeated failed soft-recoveries");
            emitSse({ type: "browser_hard_restart", at: new Date().toISOString() });
            scheduleSystemctl(["restart", "gmweb-chrome.service"]);
            setTimeout(() => scheduleSystemctl(["restart", "gmweb-api.service"]), 2500);
            recovering = false; // this process is about to be restarted anyway
          } else {
            app.log.warn(`auto-recovering browser after ${SEND_FAIL_RESTART_THRESHOLD} consecutive send failures`);
            emitSse({ type: "browser_recovering", at: new Date().toISOString() });
            client.recover()
              .then(() => app.log.info("browser recover complete"))
              .catch((e) => app.log.warn({ e }, "browser recover failed"))
              .finally(() => { recovering = false; });
          }
        }
      },
      onError: (err) => app.log.warn({ err }, "send worker error")
    },
    {
      limiter: { max: SEND_MAX_PER_MINUTE, duration: 60000 }
    }
  );
}

app.register(swagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "GMweb API",
      description: [
        "Google Messages SMS/RCS gateway — control Google Messages Web via a REST API.",
        "",
        "## Authentication",
        "All endpoints (except `/health`) require a Bearer token in the `Authorization` header.",
        "",
        "Two token types are accepted:",
        "- **Master token** (`API_TOKEN` env var) — full access to all endpoints including admin and key management.",
        "- **Project API key** (`gmw_...`) — access to messaging & conversation endpoints only. Admin routes return 401.",
        "",
        "```",
        "Authorization: Bearer gmw_your_project_token",
        "```",
        "",
        "## Rate Limits",
        "Project keys have configurable per-minute and per-hour send limits.",
        "Repeated auth failures from an IP trigger a 30-minute block."
      ].join("\n"),
      version: pkg.version,
      contact: { name: "GMweb API" }
    },
    servers: [{ url: "/", description: "This server" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "gmw_... or master API_TOKEN",
          description: "Pass your API token. Project keys start with `gmw_`. Master key is the API_TOKEN env var."
        }
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", description: "Machine-readable error code" },
            message: { type: "string", description: "Human-readable description" }
          }
        },
        Message: {
          type: "object",
          properties: {
            index: { type: "integer" },
            type: { type: "string", enum: ["message", "timestamp"] },
            direction: { type: "string", enum: ["in", "out"] },
            text: { type: "string" },
            aria: { type: "string" }
          }
        },
        Conversation: {
          type: "object",
          properties: {
            id: { type: "string" },
            href: { type: "string", description: "Stable conversation path (use as identifier)" },
            title: { type: "string", description: "Contact name" },
            snippet: { type: "string", description: "Last message preview" },
            timestamp: { type: "string" },
            unread: { type: "boolean" },
            unreadCount: { type: "integer" },
            pinned: { type: "boolean" }
          }
        },
        ApiKey: {
          type: "object",
          properties: {
            id: { type: "string", description: "Key ID (hex)" },
            name: { type: "string" },
            allowedIps: { type: "array", items: { type: "string" }, description: "Allowed source IPs. Empty = any IP." },
            sendRateMinute: { type: "integer", description: "Max /send calls per minute (0 = unlimited)" },
            sendRateHour: { type: "integer", description: "Max /send calls per hour (0 = unlimited)" },
            createdAt: { type: "string", format: "date-time" },
            lastUsedAt: { type: "string", format: "date-time", nullable: true },
            requestCount: { type: "integer" },
            enabled: { type: "boolean" },
            tokenPreview: { type: "string", description: "First 8 chars of token for identification" }
          }
        }
      }
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Messaging", description: "Send messages" },
      { name: "Conversations", description: "Browse and read conversation history" },
      { name: "Session", description: "Browser session and pairing status" },
      { name: "Admin", description: "Service administration — master token only" },
      { name: "API Keys", description: "Manage project API keys — master token only" }
    ]
  }
});

app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: true,
    displayRequestDuration: true,
    persistAuthorization: true,
    filter: true
  },
  staticCSP: false,
  transformStaticCSP: (header) => header
});

// Register reusable schemas for Fastify serialization and OpenAPI $ref
app.addSchema({
  $id: "Message",
  type: "object",
  properties: {
    index: { type: "integer" },
    type: { type: "string", enum: ["message", "timestamp"] },
    direction: { type: "string", enum: ["in", "out"] },
    text: { type: "string" },
    aria: { type: "string" }
  }
});

app.addSchema({
  $id: "Conversation",
  type: "object",
  properties: {
    id: { type: "string" },
    href: { type: "string" },
    title: { type: "string" },
    snippet: { type: "string" },
    timestamp: { type: "string" },
    unread: { type: "boolean" },
    unreadCount: { type: "integer" },
    pinned: { type: "boolean" }
  }
});

app.addSchema({
  $id: "ApiKey",
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    allowedIps: { type: "array", items: { type: "string" } },
    sendRateMinute: { type: "integer" },
    sendRateHour: { type: "integer" },
    createdAt: { type: "string" },
    lastUsedAt: { type: ["string", "null"] },
    requestCount: { type: "integer" },
    enabled: { type: "boolean" },
    tokenPreview: { type: "string" }
  }
});

app.register(cors, { origin: corsOrigin });
app.addHook("onRequest", applySecurityHeaders);
app.addHook("preHandler", requireToken);
app.setErrorHandler((error, _request, reply) => {
  const statusCode = error.statusCode || 500;
  reply.code(statusCode).send({
    error: statusCode >= 500 ? "internal_error" : "request_error",
    message: error.message,
    details: error.details
  });
});

if (config.dashboardEnabled) {
  app.register(proxy, {
    upstream: config.vncProxyTarget,
    wsUpstream: config.vncProxyTarget.replace(/^http/i, "ws"),
    prefix: "/vnc",
    websocket: true,
    preHandler: async (request, reply) => {
      if (!hasDashboardAccess(request)) {
        reply.code(401).send({ error: "unauthorized" });
      }
    }
  });
}

// Routes are registered inside app.after() so they run AFTER @fastify/swagger has
// loaded its onRoute hook. Routes added before that hook attaches are invisible to
// the generated OpenAPI spec (/docs would only show the proxy routes otherwise).
app.after(() => {

function parseLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function currentQuietHours(now = new Date()) {
  const gate = sendGate(now, {
    highPriority: false,
    timeZone: SEND_TIME_ZONE,
    startHour: SEND_QUIET_START_HOUR,
    endHour: SEND_QUIET_END_HOUR
  });
  return {
    active: gate.blocked,
    timeZone: SEND_TIME_ZONE,
    startHour: SEND_QUIET_START_HOUR,
    endHour: SEND_QUIET_END_HOUR,
    releaseAt: gate.releaseAt?.toISOString() || null
  };
}

const STAGE_LABELS = {
  pacing: "Waiting for send pacing",
  quiet_hours: "Quiet hours (02:00–08:00 Asia/Tehran)",
  legacy_queued: "Imported from the existing Redis backlog",
  legacy_active: "Active job imported from the existing Redis backlog",
  checking_paired: "Checking Google Messages session",
  opening: "Opening recipient conversation",
  locating: "Searching existing conversations",
  conversation_pacing: "Waiting before opening a new conversation",
  start_chat: "Opening Start chat",
  opening_start_chat: "Opening Start chat",
  restarting_start_chat: "Retrying Start chat",
  recipient_input_ready: "Recipient field ready",
  recipient_filled: "Recipient entered",
  selecting_recipient: "Selecting recipient",
  open_by_url: "Opening cached conversation URL",
  typing: "Typing and sending message",
  send_unverified: "Send was not confirmed; retrying UI",
  retrying_without_reload: "Retrying without reloading Messages",
  browser_unresponsive: "Chrome automation is unresponsive; recovery scheduled",
  google_rate_limited: "Google asked the gateway to wait",
  sent: "Send confirmed",
  failed: "Send attempt failed"
};

function enrichQueueJob(job) {
  const now = Date.now();
  const ledger = sendStore.byJob(job.id);
  const createdMs = Date.parse(job.createdAt || "") || ledger?.created_at || now;
  const processedMs = Date.parse(job.processedAt || "") || ledger?.active_at || 0;
  const stageMs = ledger?.stage_at || ledger?.updated_at || 0;
  const activeForMs = job.state === "active" && processedMs ? now - processedMs : 0;
  const waitingForMs = job.state === "waiting" || job.state === "paused" || job.state === "delayed"
    ? now - createdMs : Math.max(0, processedMs - createdMs);
  const stage = ledger?.stage || null;
  const stageForMs = stageMs ? Math.max(0, now - stageMs) : 0;
  const quietHours = currentQuietHours(new Date(now));
  const quietHoursHeld = quietHours.active &&
    (job.priority !== "high" || job.state === "delayed") &&
    ["waiting", "paused", "delayed"].includes(job.state);
  const visibleStage = quietHoursHeld ? "quiet_hours" : stage;

  let diagnosis = { code: "queued", severity: "info", message: "Waiting for its turn in the queue" };
  if (quietHoursHeld) {
    diagnosis = {
      code: "quiet_hours", severity: "info",
      message: job.priority === "high"
        ? `Delayed HIGH retry held by quiet hours until 08:00 ${SEND_TIME_ZONE}`
        : `Held by quiet hours until 08:00 ${SEND_TIME_ZONE}; only fresh HIGH messages can send now`
    };
  } else if (job.state === "delayed") {
    diagnosis = job.deferReason === "quiet_hours"
      ? { code: "quiet_hours", severity: "info", message: "Normal SMS paused until 08:00 Asia/Tehran; HIGH priority can send now" }
      : {
          code: "retry_backoff", severity: "warning",
          message: job.failedReason ? `Retry scheduled after: ${job.failedReason}` : "Waiting for retry delay"
        };
  } else if (job.state === "active") {
    if (stage === "browser_unresponsive" || activeForMs >= SEND_TIMEOUT_MS) {
      diagnosis = { code: "browser_unresponsive", severity: "error", message: "Chrome/Google Messages automation is hung; automatic recovery is scheduled" };
    } else if (!stage && activeForMs > 15000) {
      diagnosis = { code: "waiting_browser_lock", severity: "warning", message: "Waiting for the browser automation lock; a previous browser action may be stuck" };
    } else {
      diagnosis = { code: stage || "starting", severity: activeForMs > 120000 ? "warning" : "info", message: STAGE_LABELS[stage] || "Starting browser operation" };
    }
  }

  return {
    ...job,
    stage: visibleStage,
    stageLabel: visibleStage ? (STAGE_LABELS[visibleStage] || visibleStage) : null,
    stageAt: quietHoursHeld ? null : (stageMs ? new Date(stageMs).toISOString() : null),
    ageMs: Math.max(0, now - createdMs),
    waitingForMs,
    activeForMs,
    stageForMs: quietHoursHeld ? 0 : stageForMs,
    quietHoursHeld,
    tracking: ledger ? "sqlite" : "redis_only",
    diagnosis
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout || 15000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? error.code || 1 : 0,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim()
      });
    });
  });
}

async function systemctl(args) {
  if (process.platform === "win32") {
    return { ok: false, code: 1, stdout: "", stderr: "systemctl is not available on Windows" };
  }
  return runCommand("sudo", ["-n", "systemctl", ...args], { timeout: 20000 });
}

function scheduleSystemctl(args) {
  if (process.platform === "win32") return false;
  const child = spawn("sudo", ["-n", "systemctl", ...args], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return true;
}

async function serviceInfo(name) {
  if (process.platform === "win32") {
    return { name, active: "unsupported", enabled: "unsupported" };
  }
  const [active, enabled] = await Promise.all([
    runCommand("systemctl", ["is-active", name], { timeout: 5000 }),
    runCommand("systemctl", ["is-enabled", name], { timeout: 5000 })
  ]);
  return {
    name,
    active: active.stdout || "unknown",
    enabled: enabled.stdout || "unknown"
  };
}

async function sendDashboardFile(reply, filename) {
  const safeName = filename || "index.html";
  if (safeName.includes("/") || safeName.includes("\\") || safeName.includes("..")) {
    reply.code(404).send("Not found");
    return;
  }
  const filePath = path.join(dashboardDir, safeName);
  const ext = path.extname(filePath);
  try {
    const body = await fs.readFile(filePath);
    reply.type(contentTypes[ext] || "application/octet-stream").send(body);
  } catch (error) {
    reply.code(404).send("Not found");
  }
}

// Serve the Vite SPA build (public/dashboard-next) under /app. Unknown paths
// fall back to index.html so client-side state routing works. relPath is the
// part after "/app/" (may include "assets/...").
async function sendSpaFile(reply, relPath) {
  const clean = String(relPath || "").replace(/\\/g, "/");
  if (clean.includes("..")) { reply.code(404).send("Not found"); return; }
  const candidate = clean && clean !== "/" ? path.join(spaDir, clean) : path.join(spaDir, "index.html");
  const ext = path.extname(candidate);
  try {
    const body = await fs.readFile(candidate);
    reply.type(contentTypes[ext] || "application/octet-stream").send(body);
  } catch {
    // SPA fallback: serve index.html for any non-asset path
    try {
      const html = await fs.readFile(path.join(spaDir, "index.html"));
      reply.type("text/html; charset=utf-8").send(html);
    } catch {
      reply.code(404).send("Console not built. Run: npm --prefix dashboard-next run build");
    }
  }
}

app.get("/health", {
  schema: {
    summary: "Health check",
    description: "Returns 200 if the API server process is running. Does **not** require authentication.",
    tags: ["Session"],
    security: [],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          service: { type: "string" },
          version: { type: "string" }
        }
      }
    }
  }
}, async () => ({
  ok: true,
  service: pkg.name,
  version: pkg.version
}));

if (config.dashboardEnabled) {
  app.get("/", async (_request, reply) => reply.redirect("/dashboard"));

  app.get("/dashboard", async (_request, reply) => sendDashboardFile(reply, "index.html"));
  app.get("/dashboard/", async (_request, reply) => sendDashboardFile(reply, "index.html"));
  app.get("/dashboard/:file", async (request, reply) => sendDashboardFile(reply, request.params.file));

  // New React console (Vite SPA). Static assets + SPA fallback. Hidden from OpenAPI.
  app.get("/app", { schema: { hide: true } }, async (_request, reply) => sendSpaFile(reply, "index.html"));
  app.get("/app/", { schema: { hide: true } }, async (_request, reply) => sendSpaFile(reply, "index.html"));
  app.get("/app/*", { schema: { hide: true } }, async (request, reply) => sendSpaFile(reply, request.params["*"]));

  app.get("/dashboard/session", async (request) => {
    const session = dashboardSession(request);
    const passwordSession = dashboardPasswordSession(request);
    return {
      passwordRequired: passwordAuthEnabled(),
      passwordAuthenticated: Boolean(passwordSession),
      authenticated: Boolean(session),
      csrfToken: session ? session.csrfToken : null,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null
    };
  });

  app.post("/dashboard/password-login", async (request, reply) => {
    if (!passwordAuthEnabled()) {
      return { ok: true, passwordRequired: false };
    }
    const limit = checkRateLimit(request, "dashboard-password-login", config.dashboardPasswordMax, config.dashboardPasswordWindowMs);
    if (!limit.allowed) {
      reply.header("retry-after", String(limit.retryAfterSeconds));
      reply.code(429).send({ error: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds });
      return;
    }

    const schema = z.object({
      username: z.string().min(1).max(128),
      password: z.string().min(1).max(512)
    });
    const parsed = schema.safeParse(request.body || {});
    const username = parsed.success ? parsed.data.username : "";
    const password = parsed.success ? parsed.data.password : "";
    const usernameValid = safeStringEqual(username, config.dashboardUsername);
    const passwordHash = usernameValid ? config.dashboardPasswordHash : dummyDashboardPasswordHash;
    const passwordValid = verifyDashboardPassword(password, passwordHash);
    const valid = parsed.success && usernameValid && passwordValid;
    if (!valid) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const passwordSession = createDashboardPasswordSession(request);
    reply.header(
      "set-cookie",
      `${dashboardPasswordCookieName}=${encodeURIComponent(passwordSession.sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.dashboardPasswordSessionTtlMs / 1000)}${config.dashboardCookieSecure ? "; Secure" : ""}`
    );
    return { ok: true, passwordRequired: true };
  });

  app.post("/dashboard/login", async (request, reply) => {
    if (!dashboardPasswordSession(request)) {
      reply.code(403).send({ error: "password_login_required" });
      return;
    }
    const limit = checkRateLimit(request, "dashboard-login", config.dashboardLoginMax, config.dashboardLoginWindowMs);
    if (!limit.allowed) {
      reply.header("retry-after", String(limit.retryAfterSeconds));
      reply.code(429).send({ error: "rate_limited" });
      return;
    }
    const schema = z.object({ token: z.string().min(1) });
    const parsed = schema.safeParse(request.body || {});
    if (!parsed.success || (config.apiToken && parsed.data.token !== config.apiToken)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const session = createDashboardSession(request);
    reply.header(
      "set-cookie",
      `${dashboardSessionCookieName}=${encodeURIComponent(session.sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.dashboardSessionTtlMs / 1000)}${config.dashboardCookieSecure ? "; Secure" : ""}`
    );
    return { ok: true, csrfToken: session.csrfToken };
  });

  app.post("/dashboard/logout", async (request, reply) => {
    const session = dashboardSession(request);
    if (session && !csrfAllowed(request, session)) {
      reply.code(403).send({ error: "csrf_failed" });
      return;
    }
    clearDashboardSession(request);
    reply.header("set-cookie", [
      `${dashboardSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.dashboardCookieSecure ? "; Secure" : ""}`,
      `${dashboardPasswordCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.dashboardCookieSecure ? "; Secure" : ""}`
    ]);
    return { ok: true };
  });
}

app.get("/admin/overview", {
  schema: {
    summary: "Service overview",
    description: "Returns pairing status, browser state, and systemd service health for all GMweb components. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          service: { type: "string" },
          version: { type: "string" },
          now: { type: "string", format: "date-time" },
          adminActionsEnabled: { type: "boolean" },
          readiness: {
            type: "object",
            additionalProperties: true,
            properties: {
              ready: { type: "boolean" },
              status: { type: "object", additionalProperties: true }
            }
          },
          browserAutomation: { type: "object", additionalProperties: true },
          system: {
            type: "object",
            properties: {
              cpu: {
                type: "object",
                properties: {
                  cores: { type: "integer" }, usagePercent: { type: "number" },
                  load1: { type: "number" }, load5: { type: "number" }, load15: { type: "number" },
                  loadPercent: { type: "number" }
                }
              },
              memory: {
                type: "object",
                properties: {
                  totalBytes: { type: "integer" }, availableBytes: { type: "integer" },
                  usedBytes: { type: "integer" }, usagePercent: { type: "number" }
                }
              },
              swap: {
                type: "object",
                properties: {
                  totalBytes: { type: "integer" }, usedBytes: { type: "integer" }, usagePercent: { type: "number" }
                }
              },
              uptimeSeconds: { type: "integer" }
            }
          },
          services: { type: "array", items: { type: "object", additionalProperties: true } }
        }
      }
    }
  }
}, async () => {
  let readiness;
  let browserAutomation = { ok: null, code: "not_checked" };
  try {
    // Non-blocking: serves the cached pairing status so this endpoint never
    // queues behind in-flight sends on the single browser lock.
    const status = await client.statusForDashboard();
    readiness = { ready: status.paired, status };
  } catch (error) {
    readiness = { ready: false, error: error.message };
  }
  try {
    browserAutomation = JSON.parse(await fs.readFile(browserHealthFile, "utf8"));
  } catch { /* watchdog has not written its first probe yet */ }

  const services = await Promise.all([
    serviceInfo("gmweb-chrome.service"),
    serviceInfo("gmweb-api.service"),
    serviceInfo("gmweb-vnc.service"),
    serviceInfo("gmweb-novnc.service")
  ]);
  const system = await readSystemMetrics();

  return {
    ok: true,
    service: pkg.name,
    version: pkg.version,
    now: new Date().toISOString(),
    adminActionsEnabled: config.adminActionsEnabled,
    vnc: {
      proxyPath: "/vnc/vnc.html?autoconnect=true&resize=scale&path=vnc/websockify",
      target: config.vncProxyTarget,
      ready: services.some((service) => service.name === "gmweb-vnc.service" && service.active === "active") &&
        services.some((service) => service.name === "gmweb-novnc.service" && service.active === "active")
    },
    readiness,
    browserAutomation,
    system,
    services
  };
});

app.post("/admin/action", {
  schema: {
    summary: "Run admin action",
    description: "Trigger a system-level action such as restarting the browser, toggling VNC, or running a smoke test. **Master token only.**",
    tags: ["Admin"],
    body: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["vnc-on", "vnc-off", "restart-api", "restart-chrome", "browser-start", "browser-restart", "smoke"],
          description: "`restart-api` and `restart-chrome` are async (return immediately). All others are synchronous."
        }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          action: { type: "string" },
          queued: { type: "boolean", description: "True for async actions that are scheduled but not yet complete" }
        }
      }
    }
  }
}, async (request, reply) => {
  const limit = checkRateLimit(request, "admin-action", config.adminActionMax, config.adminActionWindowMs);
  if (!limit.allowed) {
    reply.header("retry-after", String(limit.retryAfterSeconds));
    reply.code(429).send({ error: "rate_limited" });
    return;
  }

  if (!config.adminActionsEnabled) {
    reply.code(403).send({ error: "admin_actions_disabled" });
    return;
  }

  const schema = z.object({
    action: z.enum([
      "vnc-on",
      "vnc-off",
      "restart-api",
      "restart-chrome",
      "browser-start",
      "browser-restart",
      "smoke"
    ])
  });
  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  const { action } = parsed.data;
  if (action === "browser-start") {
    await client.start();
    return { ok: true, action, status: await client.status() };
  }
  if (action === "browser-restart") {
    await client.stop();
    await client.start();
    return { ok: true, action, status: await client.status() };
  }
  if (action === "smoke") {
    const status = await client.status();
    const conversations = await client.listConversations(3);
    return { ok: true, action, status, conversations };
  }
  if (action === "vnc-on") {
    const result = await systemctl(["start", "gmweb-vnc.service", "gmweb-novnc.service"]);
    return { ok: result.ok, action, result };
  }
  if (action === "vnc-off") {
    const result = await systemctl(["stop", "gmweb-novnc.service", "gmweb-vnc.service"]);
    return { ok: result.ok, action, result };
  }
  if (action === "restart-api") {
    scheduleSystemctl(["restart", "gmweb-api.service"]);
    return { ok: true, action, queued: true };
  }
  if (action === "restart-chrome") {
    scheduleSystemctl(["restart", "gmweb-chrome.service"]);
    setTimeout(() => scheduleSystemctl(["restart", "gmweb-api.service"]), 2500);
    return { ok: true, action, queued: true };
  }
});

app.get("/ready", {
  schema: {
    summary: "Readiness check",
    description: "Returns 200 if Google Messages is paired and ready to send/receive. Returns 503 if not paired. Use this before calling `/send` to verify readiness.",
    tags: ["Session"],
    response: {
      200: { type: "object", properties: { ready: { type: "boolean" }, status: { type: "object", additionalProperties: true } } },
      503: { type: "object", properties: { ready: { type: "boolean" }, status: { type: "object", additionalProperties: true } } }
    }
  }
}, async (request, reply) => {
  // Non-blocking: cached status so /ready stays fast during send bursts.
  const status = await client.statusForDashboard();
  if (!status.paired) reply.code(503);
  return {
    ready: status.paired,
    status
  };
});

app.post("/browser/start", {
  schema: {
    summary: "Start browser",
    description: "Launches the Playwright browser and navigates to Google Messages. **Master token only.**",
    tags: ["Admin"]
  }
}, async () => {
  await client.start();
  return client.status();
});

app.post("/browser/stop", {
  schema: {
    summary: "Stop browser",
    description: "Gracefully closes the Playwright browser context. **Master token only.**",
    tags: ["Admin"]
  }
}, async () => {
  await client.stop();
  return { stopped: true };
});

app.post("/browser/restart", {
  schema: {
    summary: "Restart browser",
    description: "Stops and restarts the Playwright browser. Use after pairing issues. **Master token only.**",
    tags: ["Admin"]
  }
}, async () => {
  await client.stop();
  await client.start();
  return client.status();
});

app.get("/session/status", {
  schema: {
    summary: "Browser session status",
    description: "Returns detailed browser and pairing state including URL, QR visibility, and pairing hint. **Master token only.**",
    tags: ["Session"]
  }
}, async () => client.status());

app.get("/session/screenshot", {
  schema: {
    summary: "Browser screenshot",
    description: "Returns a full-page PNG screenshot of the current browser state. Useful for debugging pairing issues. **Master token only.**",
    tags: ["Session"],
    produces: ["image/png"],
    response: { 200: { type: "string", format: "binary" } }
  }
}, async (_request, reply) => {
  const image = await client.screenshot();
  reply.type("image/png").send(image);
});

app.get("/conversations", {
  schema: {
    summary: "List conversations",
    description: "Returns the most recent conversations visible in the Google Messages sidebar. Each item includes title, snippet, timestamp, unread status, and a stable `href` identifier.",
    tags: ["Conversations"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 20, description: "Max number of conversations to return" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          conversations: { type: "array", items: { $ref: "Conversation#" } }
        }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 20, 2000);
  return { conversations: await client.listConversations(limit) };
});

app.get("/messages/active", {
  schema: {
    summary: "Messages in currently open conversation",
    description: "Returns messages from whichever conversation the browser currently has open. Faster than `/conversations/messages` since it skips navigation. Use after `/conversations/open`.",
    tags: ["Conversations"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max messages to return (most recent)" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          messages: { type: "array", items: { $ref: "Message#" } }
        }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 50, 200);
  return { messages: await client.getActiveConversationMessages(limit) };
});

app.post("/conversations/open", {
  schema: {
    summary: "Open a conversation",
    description: "Navigates the browser to a specific conversation. Provide exactly one of: `href` (recommended — stable identifier from `/conversations`), `id`, `title`, or `index`.",
    tags: ["Conversations"],
    body: {
      type: "object",
      properties: {
        href: { type: "string", description: "Conversation path e.g. `/web/conversations/1234`. Most reliable identifier." },
        id: { type: "string", description: "Conversation ID (same as href in most cases)" },
        title: { type: "string", description: "Contact name (fuzzy matched)" },
        index: { type: "integer", minimum: 0, description: "Zero-based position in conversation list" }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    id: z.string().optional(),
    href: z.string().optional(),
    title: z.string().optional(),
    index: z.number().int().nonnegative().optional()
  }).refine((body) => body.id || body.href || body.title || Number.isInteger(body.index), {
    message: "Provide one of: id, href, title, index"
  });

  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  return client.openConversation(parsed.data);
});

app.post("/conversations/messages", {
  schema: {
    summary: "Get conversation messages",
    description: "Opens the specified conversation and returns its messages. Slower than `/messages/active` because it navigates the browser. Returns both message bubbles and timestamps in order.",
    tags: ["Conversations"],
    body: {
      type: "object",
      properties: {
        href: { type: "string", description: "Conversation path from `/conversations` response. Use this for reliability." },
        id: { type: "string" },
        title: { type: "string" },
        index: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max messages to return" }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          conversation: { $ref: "Conversation#" },
          messages: { type: "array", items: { $ref: "Message#" } }
        }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    id: z.string().optional(),
    href: z.string().optional(),
    title: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(200).optional()
  }).refine((body) => body.id || body.href || body.title || Number.isInteger(body.index), {
    message: "Provide one of: id, href, title, index"
  });

  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  const { limit = 50, ...query } = parsed.data;
  return client.getConversationMessages(query, limit);
});

if (config.enableDebugRoutes) {
  app.get("/debug/sidebar", async (request) => {
    const limit = parseLimit(request.query.limit, 80, 300);
    return {
      elements: await client.debugSidebarElements(limit)
    };
  });

  app.get("/debug/main", async (request) => {
    const limit = parseLimit(request.query.limit, 120, 500);
    return {
      elements: await client.debugMainElements(limit)
    };
  });
}

app.post("/send", {
  schema: {
    summary: "Send a message (queued)",
    description: [
      "Queue an SMS/RCS message for delivery via Google Messages.",
      "",
      "**Asynchronous by default.** The message is added to a durable Redis-backed",
      "queue and processed in the background by a single worker (one browser, one",
      "send at a time). The endpoint returns a `jobId` immediately with HTTP 202.",
      "",
      "**Track delivery via:**",
      "- `GET /send/status/{jobId}` — poll the job state",
      "- `GET /events` (SSE) — real-time `send_processing` / `send_completed` / `send_failed`",
      "",
      "**Retries:** failed sends retry up to 3 times with exponential backoff.",
      "",
      "**Synchronous mode:** pass `\"wait\": true` to block until the send finishes",
      "(up to 90s) and receive the result directly. Use only for low-volume callers.",
      "",
      "**Priority:** pass `\"priority\": \"high\"` to jump the queue. A high-priority",
      "message is processed **next** (right after the send already in flight finishes),",
      "ahead of every normal-priority message still waiting — then the queue/campaign",
      "continues as before. Use it for time-sensitive transactional messages (e.g. a",
      "renewal confirmation) so they aren't stuck behind a bulk reminder campaign.",
      "",
      "**Quiet hours:** normal-priority messages are held from 02:00 through 07:59",
      "`Asia/Tehran` and released at 08:00. Delayed retries are also held even when",
      "HIGH; only a fresh high-priority first attempt bypasses quiet hours.",
      "",
      "**Rate limits (project keys):** configurable per-minute and per-hour (default 10/min, 100/hr).",
      "",
      "**Phone format:** include country code, e.g. `+989121234567`.",
      "",
      "**Auto de-dupe:** an identical `{to,text}` re-sent within ~120s (no Idempotency-Key needed) is suppressed and returns `status:\"duplicate_suppressed\"` with the original `jobId` — guards against accidental double-posting."
    ].join("\n"),
    tags: ["Messaging"],
    body: {
      type: "object",
      required: ["to", "text"],
      properties: {
        to: { type: "string", minLength: 3, maxLength: 32, description: "Recipient phone number with country code, e.g. `+989121234567`" },
        text: { type: "string", minLength: 1, maxLength: 4000, description: "Message content. Plain text only." },
        wait: { type: "boolean", default: false, description: "If true, block until the send completes (max 90s) and return the result." },
        priority: {
          type: ["string", "integer"],
          description: "Send priority. A fresh `\"high\"` first attempt jumps the queue and bypasses the 02:00–08:00 Asia/Tehran hold. Once delayed/retrying, every job is held until 08:00 even if HIGH. Omit or use `\"normal\"` for FIFO. A numeric 1-10 is also accepted (1-3 = high)."
        }
      },
      examples: [{ to: "+989121234567", text: "Hello from GMweb API!", priority: "high" }]
    },
    headers: {
      type: "object",
      properties: {
        "idempotency-key": {
          type: "string",
          description: "Optional. A unique id for this send. Retrying with the same key returns the original `jobId` instead of sending a duplicate (kept 24h). Reusing a key with a different `to`/`text` returns 409."
        }
      }
    },
    response: {
      202: {
        type: "object",
        description: "Message accepted and queued",
        properties: {
          ok: { type: "boolean" },
          jobId: { type: "string" },
          status: { type: "string", enum: ["queued"] },
          priority: { type: "string", enum: ["high", "normal"] },
          deduped: { type: "boolean", description: "True if this returned an existing job for a repeated Idempotency-Key." },
          queuePosition: { type: "integer", description: "Approximate number of jobs ahead (incl. active). ~0 for high priority." }
        }
      },
      409: {
        type: "object",
        description: "Idempotency-Key reused with different content",
        properties: {
          error: { type: "string", enum: ["idempotency_key_reused"] },
          message: { type: "string" }
        }
      },
      200: {
        type: "object",
        description: "Returned when wait=true and the send succeeded, for a deduped Idempotency-Key whose job already completed, or when an identical {to,text} was suppressed within the dedupe window (`duplicate_suppressed`).",
        properties: {
          ok: { type: "boolean" },
          jobId: { type: ["string", "null"] },
          status: { type: "string", enum: ["completed", "duplicate_suppressed"] },
          reason: { type: "string", enum: ["duplicate_suppressed", "duplicate_inflight"], description: "Why a send was suppressed: already sent within the window, or still in flight." },
          deduped: { type: "boolean" },
          priority: { type: "string", enum: ["high", "normal"] },
          result: { type: "object" }
        }
      },
      429: {
        type: "object",
        properties: {
          error: { type: "string", enum: ["send_rate_limited"] },
          reason: { type: "string", enum: ["per_minute_limit", "per_hour_limit"] },
          limits: { type: "object", properties: { minute: { type: "integer" }, hour: { type: "integer" } } },
          used: { type: "object", properties: { minute: { type: "integer" }, hour: { type: "integer" } } }
        }
      },
      502: {
        type: "object",
        description: "Returned only when wait=true and the send failed",
        properties: {
          ok: { type: "boolean" },
          jobId: { type: "string" },
          status: { type: "string", enum: ["failed"] },
          error: { type: "string" }
        }
      }
    }
  }
}, async (request, reply) => {
  // Per-project rate limit (only applies to project API keys, not master)
  const projectKey = request._projectKey;
  if (projectKey) {
    const rate = apiKeyStore.checkSendRate(projectKey.id);
    if (!rate.allowed) {
      reply.header("retry-after", "60");
      reply.code(429).send({
        error: "send_rate_limited",
        reason: rate.reason,
        limits: rate.limits,
        used: { minute: rate.minuteUsed, hour: rate.hourUsed }
      });
      return;
    }
  }

  const schema = z.object({
    to: z.string().min(3).max(32),
    text: z.string().min(1).max(4000),
    wait: z.boolean().optional(),
    priority: z.union([z.enum(["high", "normal"]), z.number().int().min(1).max(10)]).optional()
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const { to, text, wait, priority } = parsed.data;

  // High priority -> lifo: BullMQ adds the job to the tail of the wait list,
  // which the worker pops next (it consumes from the tail). So a high-priority
  // message runs right after the in-flight send, ahead of all waiting normal
  // messages, then the campaign continues. A numeric priority <=3 is also "high".
  const highPriority = priority === "high" || (typeof priority === "number" && priority <= 3);
  const enqueueOpts = highPriority
    ? { lifo: true }
    : (typeof priority === "number" ? { priority } : {});

  // Idempotency: if the caller sends an `Idempotency-Key` header, dedupe retries
  // so a network blip doesn't send the SMS twice. Same key -> original jobId.
  const idemKey = String(request.headers["idempotency-key"] || "").trim().slice(0, 200) || null;
  const bodyHash = idemKey ? crypto.createHash("sha256").update(`${to}\n${text}`).digest("hex").slice(0, 16) : null;
  if (idemKey) {
    const reserved = await sendQueue.reserveIdempotency(idemKey, bodyHash).catch(() => "OK");
    if (reserved !== "OK") {
      // Duplicate. Wait briefly if the first request is still reserving, then
      // return the original job (or 409 if the key was reused with new content).
      let rec = await sendQueue.getIdempotency(idemKey);
      for (let i = 0; i < 20 && rec && rec.pending; i++) {
        await new Promise((r) => setTimeout(r, 100));
        rec = await sendQueue.getIdempotency(idemKey);
      }
      if (rec && rec.bodyHash !== bodyHash) {
        reply.code(409).send({ error: "idempotency_key_reused", message: "This Idempotency-Key was already used with a different to/text." });
        return;
      }
      if (rec && rec.jobId) {
        const st = await sendQueue.jobStatus(rec.jobId).catch(() => null);
        const done = st?.state === "completed";
        reply.code(done ? 200 : 202);
        return { ok: true, jobId: rec.jobId, status: done ? "completed" : "queued", priority: highPriority ? "high" : "normal", deduped: true };
      }
      // Original job expired/purged — re-reserve and fall through to send fresh.
      await sendQueue.reserveIdempotency(idemKey, bodyHash).catch(() => {});
    }
  }

  // Durable 24h de-dupe + status ledger (skipped when an explicit Idempotency-Key
  // is used — that path dedupes its own way). Atomically claims the {to,text}:
  // if an identical message was already sent within the window, or is still in
  // flight, suppress it instead of sending again.
  let ledgerId = null;
  if (!idemKey) {
    const claim = sendStore.claim({
      to, text, keyName: projectKey?.name || "master",
      priority: highPriority ? "high" : "normal", windowMs: SEND_DEDUPE_MS
    });
    if (claim.action !== "new") {
      app.log.warn({ to, reason: claim.action }, "duplicate send suppressed by ledger");
      reply.code(200);
      return {
        ok: true,
        jobId: claim.row.job_id || null,
        status: "duplicate_suppressed",
        reason: claim.action,           // duplicate_suppressed | duplicate_inflight
        deduped: true,
        priority: highPriority ? "high" : "normal"
      };
    }
    ledgerId = claim.id;
  } else {
    ledgerId = sendStore.create({
      to, text, keyName: projectKey?.name || "master",
      priority: highPriority ? "high" : "normal", idempotencyKey: idemKey
    });
  }

  let job;
  try {
    job = await sendQueue.enqueue(
      {
        to,
        text,
        keyId: projectKey?.id || null,
        keyName: projectKey?.name || "master",
        priority: highPriority ? "high" : "normal",
        _idempotencyKey: idemKey,
        _bodyHash: bodyHash
      },
      enqueueOpts
    );
  } catch (error) {
    if (idemKey) await sendQueue.releaseIdempotency(idemKey);
    if (ledgerId) sendStore.markById(ledgerId, "failed", error.message);
    throw error;
  }
  if (idemKey) await sendQueue.setIdempotencyJob(idemKey, job.id, bodyHash).catch(() => {});
  if (ledgerId) sendStore.attachJob(ledgerId, job.id);
  emitSse({ type: "send_queued", jobId: job.id, to, priority: highPriority ? "high" : "normal", at: new Date().toISOString() });

  if (wait) {
    try {
      const result = await sendQueue.waitForJob(job, 90000);
      if (result?.deferred) {
        reply.code(202);
        return {
          ok: true,
          jobId: result.deferredJobId,
          status: "deferred",
          priority: result.priority,
          reason: result.reason,
          releaseAt: result.releaseAt,
          timeZone: result.timeZone,
          releaseAfterSuccesses: result.releaseAfterSuccesses
        };
      }
      return { ok: true, jobId: job.id, status: "completed", result };
    } catch (error) {
      reply.code(502).send({ ok: false, jobId: job.id, status: "failed", error: error.message });
      return;
    }
  }

  const counts = await sendQueue.counts().catch(() => ({}));
  reply.code(202);
  return {
    ok: true,
    jobId: job.id,
    status: "queued",
    priority: highPriority ? "high" : "normal",
    queuePosition: highPriority ? (counts.active || 0) : (counts.waiting || 0) + (counts.active || 0)
  };
});

app.get("/send/status/:jobId", {
  schema: {
    summary: "Get send job status",
    description: "Returns the current state of a queued send job: `waiting`, `active`, `completed`, `failed`, or `delayed` (awaiting retry). Includes attempt count and result/error.",
    tags: ["Messaging"],
    params: { type: "object", properties: { jobId: { type: "string" } } },
    response: {
      200: {
        type: "object",
        properties: {
          id: { type: "string" },
          state: { type: "string", enum: ["waiting", "active", "completed", "failed", "delayed"] },
          to: { type: "string" },
          attemptsMade: { type: "integer" },
          maxAttempts: { type: "integer" },
          result: { type: ["object", "null"] },
          failedReason: { type: ["string", "null"] },
          createdAt: { type: ["string", "null"] },
          processedAt: { type: ["string", "null"] },
          finishedAt: { type: ["string", "null"] }
        }
      }
    }
  }
}, async (request, reply) => {
  const status = await sendQueue.jobStatus(request.params.jobId);
  if (!status) { reply.code(404).send({ error: "not_found" }); return; }
  return status;
});

app.get("/admin/queue", {
  schema: {
    summary: "Send queue stats",
    description: "Returns counts of jobs by state in the send queue. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          paused: { type: "boolean" },
          quietHours: {
            type: "object",
            properties: {
              active: { type: "boolean" },
              timeZone: { type: "string" },
              startHour: { type: "integer" },
              endHour: { type: "integer" },
              releaseAt: { type: ["string", "null"] }
            }
          },
          counts: {
            type: "object",
            properties: {
              waiting: { type: "integer" },
              paused: { type: "integer" },
              active: { type: "integer" },
              completed: { type: "integer" },
              failed: { type: "integer" },
              delayed: { type: "integer" }
            }
          }
        }
      }
    }
  }
}, async () => ({
  paused: await sendQueue.isPaused(),
  counts: await sendQueue.counts(),
  quietHours: currentQuietHours()
}));

app.post("/admin/queue/pause", {
  schema: {
    summary: "Pause the send queue",
    description: "Stops new send jobs from starting; the current active job, if any, is allowed to finish. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: { ok: { type: "boolean" }, paused: { type: "boolean" } }
      }
    }
  }
}, async () => {
  await sendQueue.pause();
  emitSse({ type: "queue_paused", reason: "manual", at: new Date().toISOString() });
  return { ok: true, paused: true };
});

app.post("/admin/queue/resume", {
  schema: {
    summary: "Resume the paced send queue",
    description: "Allows queued jobs to start again under the configured send pacing limits. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: { ok: { type: "boolean" }, paused: { type: "boolean" } }
      }
    }
  }
}, async () => {
  await sendQueue.resume();
  emitSse({ type: "queue_resumed", at: new Date().toISOString() });
  return { ok: true, paused: false };
});

app.get("/admin/sends", {
  schema: {
    summary: "Send ledger (durable)",
    description: "Returns the persistent send ledger: status counts and the most recent messages with their delivery state. Survives restarts and powers the 24h de-dupe. **Master token only.**",
    tags: ["Admin"],
    querystring: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 } }
    },
    response: {
      200: {
        type: "object",
        properties: {
          stats: {
            type: "object",
            properties: {
              queued: { type: "integer" }, active: { type: "integer" }, sent: { type: "integer" },
              failed: { type: "integer" }, suppressed: { type: "integer" }
            }
          },
          sends: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                to: { type: "string" },
                textPreview: { type: "string" },
                keyName: { type: ["string", "null"] },
                jobId: { type: ["string", "null"] },
                status: { type: "string" },
                stage: { type: ["string", "null"], description: "Granular progress within an active send (opening, locating, start_chat, stuck_reloading, composer_ready, typing, sent...)" },
                attempts: { type: "integer" },
                error: { type: ["string", "null"] },
                createdAt: { type: ["string", "null"] },
                sentAt: { type: ["string", "null"] }
              }
            }
          }
        }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 100, 1000);
  const sends = sendStore.recent(limit).map((r) => ({
    id: r.id,
    to: r.to_number,
    textPreview: String(r.text || "").replace(/\s+/g, " ").slice(0, 80),
    keyName: r.key_name,
    jobId: r.job_id,
    status: r.status,
    stage: r.stage || null,
    attempts: r.attempts,
    error: r.error,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null
  }));
  return { stats: sendStore.stats(), sends };
});

app.get("/admin/queue/jobs", {
  schema: {
    summary: "List queued send jobs",
    description: "Returns pending send jobs in actual processing order (active first, then next-to-run), with a text preview and priority. `delayedHighCount` covers the complete queue even when the visible list is limited. **Master token only.**",
    tags: ["Admin"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 }
      }
    },
    response: {
      200: {
        type: "object",
        properties: {
          jobs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                state: { type: "string" },
                to: { type: ["string", "null"] },
                textPreview: { type: "string" },
                keyName: { type: ["string", "null"] },
                priority: { type: "string", enum: ["high", "normal"] },
                attemptsMade: { type: "integer" },
                maxAttempts: { type: "integer" },
                failedReason: { type: ["string", "null"] },
                createdAt: { type: ["string", "null"] },
                processedAt: { type: ["string", "null"] },
                finishedAt: { type: ["string", "null"] },
                delayUntil: { type: ["string", "null"] },
                deferReason: { type: ["string", "null"] },
                deferCount: { type: "integer" },
                quietHoursHeld: { type: "boolean" },
                stage: { type: ["string", "null"] },
                stageLabel: { type: ["string", "null"] },
                stageAt: { type: ["string", "null"] },
                ageMs: { type: "integer" },
                waitingForMs: { type: "integer" },
                activeForMs: { type: "integer" },
                stageForMs: { type: "integer" },
                tracking: { type: "string", enum: ["sqlite", "redis_only"] },
                diagnosis: {
                  type: "object",
                  properties: {
                    code: { type: "string" },
                    severity: { type: "string", enum: ["info", "warning", "error"] },
                    message: { type: "string" }
                  }
                }
              }
            }
          },
          delayedHighCount: { type: "integer" },
          total: { type: "integer" }
        }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 100, 500);
  const [jobs, delayedHighCount, counts] = await Promise.all([
    sendQueue.listJobs({ limit }),
    sendQueue.countDeferredHighJobs(),
    sendQueue.counts()
  ]);
  const total = (counts.active || 0) + (counts.waiting || 0) +
    (counts.paused || 0) + (counts.delayed || 0);
  return { jobs: jobs.map(enrichQueueJob), delayedHighCount, total };
});

app.post("/admin/queue/release-delayed-high", {
  schema: {
    summary: "Release all deferred high-priority jobs",
    description: "Moves every HIGH send that was previously delayed to the front of the queue for immediate processing. Preserves oldest-first order within the released batch. **Master token only.**",
    tags: ["Admin"],
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          released: { type: "integer" }
        }
      }
    }
  }
}, async () => {
  const results = await sendQueue.releaseDeferredHighJobs();
  for (const result of results) {
    const ledger = sendStore.byJob(result.previousId);
    if (ledger) sendStore.attachJob(ledger.id, result.id);
    if (result._data?._idempotencyKey && result._data?._bodyHash) {
      await sendQueue.setIdempotencyJob(result._data._idempotencyKey, result.id, result._data._bodyHash).catch(() => {});
    }
  }
  emitSse({
    type: "queue_delayed_high_released",
    count: results.length,
    at: new Date().toISOString()
  });
  return { ok: true, released: results.length };
});

app.post("/admin/queue/jobs/:id/promote", {
  schema: {
    summary: "Send a queued job first",
    description: "Moves any waiting/delayed send job—normal or HIGH—to the very front for immediate processing, ahead of all other waiting messages. Clears its current delay. **Master token only.**",
    tags: ["Admin"],
    params: { type: "object", properties: { id: { type: "string" } } }
  }
}, async (request, reply) => {
  const ledger = sendStore.byJob(request.params.id);
  const result = await sendQueue.promoteJob(request.params.id);
  if (!result) { reply.code(404).send({ error: "not_found" }); return; }
  if (result.promoted && ledger) sendStore.attachJob(ledger.id, result.id);
  if (result.promoted && result._data?._idempotencyKey && result._data?._bodyHash) {
    await sendQueue.setIdempotencyJob(result._data._idempotencyKey, result.id, result._data._bodyHash).catch(() => {});
  }
  const { _data, ...publicResult } = result;
  return { ok: true, ...publicResult };
});

app.delete("/admin/queue/jobs/:id", {
  schema: {
    summary: "Cancel a queued job",
    description: "Removes a pending send job from the queue. **Master token only.**",
    tags: ["Admin"],
    params: { type: "object", properties: { id: { type: "string" } } }
  }
}, async (request, reply) => {
  const ledger = sendStore.byJob(request.params.id);
  const ok = await sendQueue.removeJob(request.params.id);
  if (!ok) { reply.code(404).send({ error: "not_found" }); return; }
  if (ledger) sendStore.markById(ledger.id, "cancelled", "cancelled_by_admin");
  return { ok: true };
});

// ─── API Key Management (master / dashboard only) ────────────────────────────

app.get("/admin/api-keys", {
  schema: {
    summary: "List API keys",
    description: "Returns all project API keys with metadata. The actual token is **never** returned here — it is only shown once at creation. **Master token only.**",
    tags: ["API Keys"],
    response: {
      200: {
        type: "object",
        properties: {
          keys: { type: "array", items: { $ref: "ApiKey#" } }
        }
      }
    }
  }
}, async () => ({ keys: apiKeyStore.list() }));

app.post("/admin/api-keys", {
  schema: {
    summary: "Create API key",
    description: [
      "Creates a new project API key. The **full token is returned only in this response** — store it immediately.",
      "",
      "The token is stored as a SHA-256 hash on disk. If lost, use the `/rotate` endpoint to generate a new one.",
      "",
      "**Master token only.**"
    ].join("\n"),
    tags: ["API Keys"],
    body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "Human-readable project name" },
        allowedIps: {
          type: "array", items: { type: "string" }, maxItems: 30,
          description: "Allowed source IPs. Empty array = accept from any IP. Recommended: set to your server's IP."
        },
        rateLimit: {
          type: "object",
          properties: {
            minute: { type: "integer", minimum: 0, default: 10, description: "Max /send calls per minute (0 = unlimited)" },
            hour: { type: "integer", minimum: 0, default: 100, description: "Max /send calls per hour (0 = unlimited)" }
          }
        }
      },
      examples: [{ name: "MyProject", allowedIps: ["1.2.3.4"], rateLimit: { minute: 5, hour: 50 } }]
    },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          key: {
            allOf: [{ $ref: "ApiKey#" }],
            properties: { token: { type: "string", description: "Full token — shown ONCE. Store it now." } }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    name: z.string().min(1).max(64),
    allowedIps: z.array(z.string()).max(30).optional(),
    rateLimit: z.object({
      minute: z.number().int().min(0).optional(),
      hour: z.number().int().min(0).optional()
    }).optional()
  });
  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const key = apiKeyStore.create(parsed.data);
  return { ok: true, key };
});

app.patch("/admin/api-keys/:id", {
  schema: {
    summary: "Update API key",
    description: "Update name, allowed IPs, send rate limits, or enable/disable a key. **Master token only.**",
    tags: ["API Keys"],
    params: { type: "object", properties: { id: { type: "string", description: "Key ID from list endpoint" } } },
    body: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        allowedIps: { type: "array", items: { type: "string" }, maxItems: 30 },
        enabled: { type: "boolean" },
        sendRateMinute: { type: "integer", minimum: 0, maximum: 10000 },
        sendRateHour: { type: "integer", minimum: 0, maximum: 100000 }
      }
    }
  }
}, async (request, reply) => {
  const schema = z.object({
    name: z.string().min(1).max(64).optional(),
    allowedIps: z.array(z.string()).max(30).optional(),
    enabled: z.boolean().optional(),
    sendRateMinute: z.number().int().min(0).max(10000).optional(),
    sendRateHour: z.number().int().min(0).max(100000).optional()
  });
  const parsed = schema.safeParse(request.body || {});
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const updated = apiKeyStore.update(request.params.id, parsed.data);
  if (!updated) { reply.code(404).send({ error: "not_found" }); return; }
  return { ok: true, key: updated };
});

app.post("/admin/api-keys/:id/rotate", {
  schema: {
    summary: "Rotate token",
    description: "Generates a new token for this key. **The old token is immediately invalidated.** The new token is shown only once in this response. **Master token only.**",
    tags: ["API Keys"],
    params: { type: "object", properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          key: {
            allOf: [{ $ref: "ApiKey#" }],
            properties: { token: { type: "string", description: "New token — shown ONCE." } }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  const result = apiKeyStore.rotate(request.params.id);
  if (!result) { reply.code(404).send({ error: "not_found" }); return; }
  return { ok: true, key: result };
});

app.delete("/admin/api-keys/:id", {
  schema: {
    summary: "Delete API key",
    description: "Permanently deletes a key. Any requests using this key will immediately return 401. **Master token only.**",
    tags: ["API Keys"],
    params: { type: "object", properties: { id: { type: "string" } } }
  }
}, async (request, reply) => {
  const ok = apiKeyStore.delete(request.params.id);
  if (!ok) { reply.code(404).send({ error: "not_found" }); return; }
  return { ok: true };
});

app.get("/admin/api-logs", {
  schema: {
    summary: "Request logs",
    description: "Returns the most recent API requests made with project keys (not master token). Includes timestamp, key name, IP, method, path. **Master token only.**",
    tags: ["API Keys"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        keyId: { type: "string", description: "Filter logs by a specific key ID" }
      }
    }
  }
}, async (request) => {
  const limit = parseLimit(request.query.limit, 100, 1000);
  const keyId = request.query.keyId || undefined;
  return { logs: await apiKeyStore.getLogs({ limit, keyId }) };
});

// ─────────────────────────────────────────────────────────────────────────────

app.get("/events", {
  schema: {
    summary: "Server-Sent Events stream",
    description: [
      "Subscribe to real-time events using SSE (Server-Sent Events).",
      "",
      "**Event types:**",
      "- `conversation_changed` — a conversation's last message or unread state changed",
      "- `send_queued` — a message was accepted into the send queue",
      "- `send_processing` — the worker started sending a queued message",
      "- `send_completed` — a queued message was sent successfully (includes `jobId`)",
      "- `send_failed` — a send attempt failed (`willRetry` indicates if it will be retried)",
      "",
      "**Usage (JavaScript):**",
      "```js",
      "const es = new EventSource('/events', { headers: { Authorization: 'Bearer gmw_...' } });",
      "es.onmessage = (e) => console.log(JSON.parse(e.data));",
      "```",
      "",
      "Connection stays open until closed by the client. Reconnect with exponential backoff."
    ].join("\n"),
    tags: ["Messaging"],
    produces: ["text/event-stream"],
    response: { 200: { type: "string", description: "SSE stream" } }
  }
}, async (request, reply) => {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  reply.raw.write(": connected\n\n");
  sseClients.add(reply);

  request.raw.on("close", () => {
    sseClients.delete(reply);
  });
});

}); // end app.after — routes are now registered after swagger's onRoute hook

// Crash recovery: rebuild the queue from the ledger. Any unfinished row whose
// BullMQ job is missing (e.g. Redis was wiped) is re-enqueued, so a crash can
// never lose the queue. Rows still alive in Redis are left untouched (so a plain
// API restart never double-sends).
async function reconcilePending() {
  let pending;
  try { pending = sendStore.pending(); } catch { return; }
  if (!pending.length) return;
  let restored = 0;
  for (const row of pending) {
    let alive = false;
    if (row.job_id) {
      const st = await sendQueue.jobStatus(row.job_id).catch(() => null);
      alive = st && ["waiting", "active", "delayed"].includes(st.state);
    }
    if (alive) continue;
    try {
      const job = await sendQueue.enqueue(
        { to: row.to_number, text: row.text, keyId: null, keyName: row.key_name || "reconcile", priority: "normal" },
        {}
      );
      sendStore.attachJob(row.id, job.id);
      restored += 1;
    } catch (error) {
      app.log.warn({ error: error.message, id: row.id }, "reconcile enqueue failed");
    }
  }
  if (restored) app.log.info(`reconciled ${restored} unfinished send(s) from the ledger into the queue`);
}

async function backfillPendingLedger() {
  const jobs = await sendQueue.pendingJobsForLedger(2000);
  let imported = 0;
  for (const job of jobs) {
    try { if (sendStore.backfillPending(job)) imported += 1; } catch (error) {
      app.log.warn({ jobId: job.jobId, error: error.message }, "pending ledger backfill failed");
    }
  }
  if (imported) app.log.info({ imported }, "backfilled Redis backlog into SQLite send ledger");
}

async function initializeBrowserAndConversationIndex({ resumeAfterWarm }) {
  try {
    await client.start();
    // Seed readiness before the long index lock. Without this, /ready has no
    // cached paired state and the system watchdog may restart Chrome midway
    // through a perfectly healthy sidebar warm-up.
    await client.status();
    const stats = await client.warmConversationIndex((stage) => {
      emitSse({ type: "conversation_index", stage, at: new Date().toISOString() });
    });
    app.log.info({ stats }, "conversation sidebar index ready");
    if (resumeAfterWarm) {
      await sendQueue.resume();
      emitSse({ type: "queue_resumed", reason: "conversation_index_ready", at: new Date().toISOString() });
    }
  } catch (error) {
    // Keep the queue paused: Start-chat fallback is still available after a
    // manual resume, but an automatic resume without the index would recreate
    // the slow/failure-prone behavior this warm-up is designed to prevent.
    app.log.warn({ error }, "browser/index warm-up failed; queue remains paused");
  }
}

async function main() {
  if (config.appEnv === "production" && !config.apiToken) {
    throw new Error("API_TOKEN is required when NODE_ENV=production.");
  }
  await loadSessions();
  await apiKeyStore.load();
  const queueWasPaused = await sendQueue.isPaused().catch(() => true);
  if (!queueWasPaused) await sendQueue.pause();
  startSendWorker();
  await backfillPendingLedger().catch((error) => app.log.warn({ error: error.message }, "ledger backfill failed"));
  await reconcilePending().catch((error) => app.log.warn({ error: error.message }, "reconcile failed"));
  await app.listen({ host: config.host, port: config.port });
  initializeBrowserAndConversationIndex({ resumeAfterWarm: !queueWasPaused });
}

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.log.info({ signal }, "shutting down");
  // npm/systemd may deliver the stop signal more than once, and a wedged
  // Playwright/BullMQ promise must never consume systemd's 90s stop timeout.
  // Redis + SQLite are durable, so a bounded hard exit is recovery-safe.
  const forceExit = setTimeout(() => process.exit(0), 8000);
  // Redis owns the durable job state. Force-closing the worker lets systemd
  // recovery terminate a wedged browser action immediately; BullMQ reclaims
  // the interrupted active job after restart instead of blocking StopTimeout.
  await sendQueue.close({ force: true }).catch((error) => app.log.warn({ error }, "queue close failed"));
  try { sendStore.close(); } catch (error) { app.log.warn({ error }, "ledger close failed"); }
  if (config.browserMode === "connect") client.detachForShutdown();
  else await client.stop().catch((error) => app.log.warn({ error }, "browser stop failed"));
  await app.close().catch((error) => app.log.warn({ error }, "server close failed"));
  clearTimeout(forceExit);
  process.exit(0);
}

// Only boot (listen, start worker/browser) when run directly, not when the app
// is imported by tooling such as scripts/generate-openapi.js.
if (require.main === module) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  main().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

module.exports = { app };
