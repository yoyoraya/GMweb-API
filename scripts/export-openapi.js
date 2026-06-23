#!/usr/bin/env node
// Exports the live OpenAPI spec to docs/openapi.json.
//
// The spec is generated from the route schemas in src/server.js, so it always
// matches the running code. Run this once after changing any endpoint:
//
//   API_TOKEN=<master token> npm run export:openapi
//
// Or against a remote server:
//
//   API_TOKEN=<master token> npm run export:openapi -- https://your-host
//
// The server must be running. /docs/json requires the master token.

const fs = require("node:fs/promises");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");

function baseUrl() {
  const arg = process.argv[2];
  if (arg) return arg.replace(/\/+$/, "");
  const port = process.env.PORT || 3030;
  return `http://127.0.0.1:${port}`;
}

async function main() {
  const token = process.env.API_TOKEN;
  if (!token) {
    console.error("Set API_TOKEN (master token) before running. /docs/json is admin-only.");
    process.exit(1);
  }

  const url = `${baseUrl()}/docs/json`;
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    console.error(`Could not reach ${url}. Is the server running?`);
    console.error(error.message);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`GET ${url} returned ${res.status}. Check that API_TOKEN is the master token.`);
    process.exit(1);
  }

  const spec = await res.json();
  const outPath = path.join(rootDir, "docs", "openapi.json");
  await fs.writeFile(outPath, JSON.stringify(spec, null, 2) + "\n", "utf8");

  const version = spec?.info?.version || "unknown";
  console.log(`Wrote ${path.relative(rootDir, outPath)} (version ${version}, ${Object.keys(spec.paths || {}).length} paths).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
