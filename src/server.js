const Fastify = require("fastify");
const cors = require("@fastify/cors");
const proxy = require("@fastify/http-proxy");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { z } = require("zod");
const config = require("./config");
const { GoogleMessagesClient } = require("./googleMessagesClient");
const pkg = require("../package.json");

const app = Fastify({
  logger: true,
  trustProxy: true
});

const client = new GoogleMessagesClient(config);
const sseClients = new Set();
const dashboardSessionCookieName = "gmweb_session";
const dashboardPasswordCookieName = "gmweb_login";
const dashboardDir = path.join(config.rootDir, "public", "dashboard");
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
    pathname.startsWith("/dashboard/");
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
  if (bearerToken(request) === config.apiToken) return done();

  const session = dashboardSession(request);
  if (session && csrfAllowed(request, session)) return done();

  if (session) {
    reply.code(403).send({ error: "csrf_failed" });
  } else {
    reply.code(401).send({ error: "unauthorized" });
  }
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
client.on("message:sent", (event) => {
  emitSse(event);
  postWebhook(event);
});
client.on("error", (error) => app.log.warn({ error }, "client error"));

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

function parseLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
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

app.get("/health", async () => ({
  ok: true,
  service: pkg.name,
  version: pkg.version
}));

if (config.dashboardEnabled) {
  app.get("/", async (_request, reply) => reply.redirect("/dashboard"));

  app.get("/dashboard", async (_request, reply) => sendDashboardFile(reply, "index.html"));
  app.get("/dashboard/", async (_request, reply) => sendDashboardFile(reply, "index.html"));
  app.get("/dashboard/:file", async (request, reply) => sendDashboardFile(reply, request.params.file));

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

app.get("/admin/overview", async () => {
  let readiness;
  try {
    let status = await client.status();
    if (!status.paired && !status.qrVisible && !status.signInVisible) {
      await client.listConversations(1).catch(() => {});
      status = await client.status();
    }
    readiness = { ready: status.paired, status };
  } catch (error) {
    readiness = { ready: false, error: error.message };
  }

  const services = await Promise.all([
    serviceInfo("gmweb-chrome.service"),
    serviceInfo("gmweb-api.service"),
    serviceInfo("gmweb-vnc.service"),
    serviceInfo("gmweb-novnc.service")
  ]);

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
    services
  };
});

app.post("/admin/action", async (request, reply) => {
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

app.get("/ready", async (request, reply) => {
  let status = await client.status();
  if (!status.paired && !status.qrVisible && !status.signInVisible) {
    await client.listConversations(1).catch(() => {});
    status = await client.status();
  }
  if (!status.paired) reply.code(503);
  return {
    ready: status.paired,
    status
  };
});

app.post("/browser/start", async () => {
  await client.start();
  return client.status();
});

app.post("/browser/stop", async () => {
  await client.stop();
  return { stopped: true };
});

app.post("/browser/restart", async () => {
  await client.stop();
  await client.start();
  return client.status();
});

app.get("/session/status", async () => client.status());

app.get("/session/screenshot", async (_request, reply) => {
  const image = await client.screenshot();
  reply.type("image/png").send(image);
});

app.get("/conversations", async (request) => {
  const limit = parseLimit(request.query.limit, 20, 100);
  return {
    conversations: await client.listConversations(limit)
  };
});

app.get("/messages/active", async (request) => {
  const limit = parseLimit(request.query.limit, 50, 200);
  return {
    messages: await client.getActiveConversationMessages(limit)
  };
});

app.post("/conversations/open", async (request, reply) => {
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

app.post("/conversations/messages", async (request, reply) => {
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

app.post("/send", async (request, reply) => {
  const schema = z.object({
    to: z.string().min(3).max(32),
    text: z.string().min(1).max(4000)
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  return client.sendMessage(parsed.data);
});

app.get("/events", async (request, reply) => {
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

async function main() {
  if (config.appEnv === "production" && !config.apiToken) {
    throw new Error("API_TOKEN is required when NODE_ENV=production.");
  }
  await app.listen({ host: config.host, port: config.port });
}

async function shutdown(signal) {
  app.log.info({ signal }, "shutting down");
  await client.stop().catch((error) => app.log.warn({ error }, "browser stop failed"));
  await app.close().catch((error) => app.log.warn({ error }, "server close failed"));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
