const config = require("../src/config");

const baseUrl = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${config.port}`;
const token = process.env.SMOKE_API_TOKEN || config.apiToken;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "content-type": "application/json; charset=utf-8" } : {}),
      ...options.headers
    }
  });

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error(`${options.method || "GET"} ${path} failed with ${response.status}`);
    error.body = body;
    throw error;
  }

  return body;
}

async function main() {
  const health = await request("/health");
  console.log("health:", health);

  await request("/browser/start", { method: "POST" });
  const status = await request("/session/status");
  console.log("status:", {
    paired: status.paired,
    hint: status.hint,
    url: status.url
  });

  const conversations = await request("/conversations?limit=3");
  console.log("conversations:", conversations.conversations.map((row) => ({
    title: row.title,
    timestamp: row.timestamp
  })));

  if (!status.paired) {
    throw new Error(`Google Messages is not paired: ${status.hint}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error.body) console.error(JSON.stringify(error.body, null, 2));
  process.exit(1);
});
