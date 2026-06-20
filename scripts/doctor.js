const fs = require("node:fs");
const config = require("../src/config");
const pkg = require("../package.json");

function check(name, ok, detail = "") {
  console.log(`${ok ? "OK " : "ERR"} ${name}${detail ? ` - ${detail}` : ""}`);
  return ok;
}

async function main() {
  const checks = [];
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);

  checks.push(check("node", major >= 20, process.version));
  checks.push(check("package", true, `${pkg.name}@${pkg.version}`));
  checks.push(check("api token", Boolean(config.apiToken), config.apiToken ? "set" : "missing"));
  checks.push(check("chrome executable", Boolean(config.chromeExecutablePath), config.chromeExecutablePath || "not found"));
  if (config.chromeExecutablePath) {
    checks.push(check("chrome exists", fs.existsSync(config.chromeExecutablePath), config.chromeExecutablePath));
  }
  checks.push(check("profile directory", fs.existsSync(config.userDataDir), config.userDataDir));
  checks.push(check("debug routes", !config.enableDebugRoutes, config.enableDebugRoutes ? "enabled" : "disabled"));

  if (process.env.DOCTOR_CHECK_SERVER === "true") {
    const baseUrl = process.env.DOCTOR_BASE_URL || `http://127.0.0.1:${config.port}`;
    const response = await fetch(`${baseUrl}/health`);
    checks.push(check("server health", response.ok, `${response.status} ${baseUrl}/health`));
  }

  if (checks.every(Boolean)) return;
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
