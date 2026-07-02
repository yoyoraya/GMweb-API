"use strict";

// Independent watchdog probe. /ready can legitimately serve cached pairing
// state while the single Playwright lock is busy, so it cannot detect the
// failure mode where Chrome still paints in VNC and answers /json/version but
// never completes a CDP command. This process opens a second, read-only CDP
// connection and asks the real Google Messages page to execute tiny JS. It
// also dismisses Google's "Use here" session-transfer prompt, which otherwise
// leaves Chrome alive but blocks every queued browser action behind an overlay.
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

  const sessionClaimed = await page.evaluate(() => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const dialogs = [...document.querySelectorAll("[role='dialog'], mat-dialog-container, .mdc-dialog")];
    const dialog = dialogs.find((node) => visible(node) &&
      /Use Google Messages for web here\?|open in more than one tab or browser/i.test(node.innerText || ""));
    if (!dialog) return false;
    const controls = [...dialog.querySelectorAll("button, [role='button']")];
    const button = controls.find((node) => visible(node) && /^Use here$/i.test((node.innerText || node.textContent || "").trim()));
    if (!button) return false;
    button.click();
    return true;
  });
  if (sessionClaimed) await page.waitForTimeout(750);

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
  finish(true, sessionClaimed ? "session_claimed" : "automation_healthy", { sessionClaimed, ...state });
})().catch((error) => {
  clearTimeout(hardTimer);
  finish(false, "automation_unresponsive", { error: String(error?.message || error).split("\n")[0] });
});
