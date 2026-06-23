#!/usr/bin/env node
// Generates docs/openapi.json OFFLINE — no running server required.
//
// It loads the Fastify app in-process (server.js only boots when run directly),
// waits for plugins to register, then writes the generated OpenAPI document.
// Because the spec comes from the same route schemas the server uses, it always
// matches the real API.
//
//   npm run generate:openapi
//
// Use scripts/export-openapi.js instead when you want to pull the spec from a
// live (possibly remote) server.

const fs = require("node:fs/promises");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");

async function main() {
  const { app } = require("../src/server");
  await app.ready();                 // registers swagger + all route schemas

  const spec = app.swagger();        // the generated OpenAPI document
  const outPath = path.join(rootDir, "docs", "openapi.json");
  await fs.writeFile(outPath, JSON.stringify(spec, null, 2) + "\n", "utf8");

  const version = spec?.info?.version || "unknown";
  console.log(`Wrote ${path.relative(rootDir, outPath)} (version ${version}, ${Object.keys(spec.paths || {}).length} paths).`);

  await app.close().catch(() => {});
  process.exit(0);                   // don't hang on lazy Redis sockets from the queue
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
