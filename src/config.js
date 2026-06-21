const path = require("node:path");
const fs = require("node:fs");
const dotenv = require("dotenv");

dotenv.config();

function boolFromEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFromEnv(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

const rootDir = path.resolve(__dirname, "..");

function findChromeExecutable() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

module.exports = {
  rootDir,
  appEnv: process.env.NODE_ENV || "development",
  port: intFromEnv(process.env.PORT, 3030),
  host: process.env.HOST || "0.0.0.0",
  apiToken: process.env.API_TOKEN || "",
  headless: boolFromEnv(process.env.HEADLESS, false),
  userDataDir: path.resolve(rootDir, process.env.USER_DATA_DIR || "./data/browser-profile"),
  chromeExecutablePath: findChromeExecutable(),
  browserMode: process.env.BROWSER_MODE || "launch",
  browserCdpUrl: process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222",
  pollIntervalMs: intFromEnv(process.env.POLL_INTERVAL_MS, 5000),
  conversationCacheFile: path.resolve(rootDir, process.env.CONVERSATION_CACHE_FILE || "./data/conversation-cache.json"),
  webhookUrl: process.env.WEBHOOK_URL || "",
  enableDebugRoutes: boolFromEnv(process.env.ENABLE_DEBUG_ROUTES, false),
  publicHealth: boolFromEnv(process.env.PUBLIC_HEALTH, true),
  corsOrigins: listFromEnv(process.env.CORS_ORIGIN),
  dashboardEnabled: boolFromEnv(process.env.DASHBOARD_ENABLED, true),
  adminActionsEnabled: boolFromEnv(process.env.ADMIN_ACTIONS_ENABLED, true),
  dashboardCookieSecure: boolFromEnv(process.env.DASHBOARD_COOKIE_SECURE, false),
  dashboardSessionTtlMs: intFromEnv(process.env.DASHBOARD_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
  dashboardBindUserAgent: boolFromEnv(process.env.DASHBOARD_BIND_USER_AGENT, true),
  dashboardLoginWindowMs: intFromEnv(process.env.DASHBOARD_LOGIN_WINDOW_MS, 60000),
  dashboardLoginMax: intFromEnv(process.env.DASHBOARD_LOGIN_MAX, 20),
  adminActionWindowMs: intFromEnv(process.env.ADMIN_ACTION_WINDOW_MS, 60000),
  adminActionMax: intFromEnv(process.env.ADMIN_ACTION_MAX, 60),
  vncProxyTarget: process.env.VNC_PROXY_TARGET || "http://127.0.0.1:6080"
};
