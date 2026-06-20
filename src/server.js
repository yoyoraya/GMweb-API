const Fastify = require("fastify");
const cors = require("@fastify/cors");
const { z } = require("zod");
const config = require("./config");
const { GoogleMessagesClient } = require("./googleMessagesClient");
const pkg = require("../package.json");

const app = Fastify({
  logger: true
});

const client = new GoogleMessagesClient(config);
const sseClients = new Set();

function requireToken(request, reply, done) {
  if (config.publicHealth && request.url === "/health") return done();
  if (!config.apiToken) return done();
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token !== config.apiToken) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  done();
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

app.register(cors, { origin: true });
app.addHook("preHandler", requireToken);
app.setErrorHandler((error, _request, reply) => {
  const statusCode = error.statusCode || 500;
  reply.code(statusCode).send({
    error: statusCode >= 500 ? "internal_error" : "request_error",
    message: error.message,
    details: error.details
  });
});

function parseLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

app.get("/health", async () => ({
  ok: true,
  service: pkg.name,
  version: pkg.version
}));

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
