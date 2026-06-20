const fs = require("node:fs");
const { spawn } = require("node:child_process");
const config = require("./config");

if (!config.chromeExecutablePath) {
  console.error("Chrome executable not found. Set CHROME_EXECUTABLE_PATH in .env.");
  process.exit(1);
}

fs.mkdirSync(config.userDataDir, { recursive: true });

const args = [
  `--user-data-dir=${config.userDataDir}`,
  "--profile-directory=Default",
  "--new-window",
  "--disable-extensions",
  "--no-first-run",
  "--no-default-browser-check",
  "https://messages.google.com/web"
];

const child = spawn(config.chromeExecutablePath, args, {
  detached: true,
  stdio: "ignore"
});

child.unref();

console.log("Opened normal Chrome for Google sign-in/pairing.");
console.log(`Chrome: ${config.chromeExecutablePath}`);
console.log(`Profile: ${config.userDataDir}`);
console.log("Sign in there, finish Google Messages pairing, then close that Chrome window before starting the API server.");
