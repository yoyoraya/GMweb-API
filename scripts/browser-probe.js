"use strict";

// Independent watchdog probe. /ready can legitimately serve cached pairing
// state while the single Playwright lock is busy, so it cannot detect the
// failure mode where Chrome still paints in VNC and answers /json/version but
// never completes a CDP command. This process opens a second, read-only CDP
// connection and asks the real Google Messages page to execute tiny JS.
const { chromium } = require("playwright");

const cdpUrl = process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222";
const timeoutMs = Math.max(5000, Number(process.env.BROWSER_PROBE_TIMEOUT_MS) || 15000);
const startedAt = Date.now();

function finish(ok, code, detail = {}) {
  process.stdout.write(JSON.stringify({ ok, code, latencyMs: Date.now() - startedAt, ...detail }) + "\n");
  process.exit(ok ? 0 : 1);
}

const hardTimer = setTimeout(() => finish(false, "probe_timeout", { cdpUrl }), timeoutMs + 3000);

(async () => {
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => /messages\.google\.com\/web/i.test(candidate.url()));
  if (!page) finish(false, "messages_page_missing", { pageCount: pages.length });

  const state = await Promise.race([
    page.evaluate(() => ({
      url: location.href,
      title: document.title,
      domReady: document.readyState,
      hasApp: Boolean(document.querySelector("mws-app, mws-conversations-list, nav.conversation-list")),
      hasComposer: Boolean(document.querySelector("[aria-label*='Text message' i], textarea[aria-label*='message' i], [contenteditable='true'][aria-label*='message' i]")),
      hasQr: Boolean(document.querySelector("canvas, img[alt*='QR' i]"))
    })),
    new Promise((_, reject) => setTimeout(() => reject(new Error("page_evaluate_timeout")), timeoutMs))
  ]);

  clearTimeout(hardTimer);
  finish(true, "automation_healthy", state);
})().catch((error) => {
  clearTimeout(hardTimer);
  finish(false, "automation_unresponsive", { error: String(error?.message || error).split("\n")[0] });
});
