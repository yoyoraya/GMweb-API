const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { chromium } = require("playwright");

const MESSAGES_URL = "https://messages.google.com/web";

class GoogleMessagesClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.pollTimer = null;
    this.lastConversationFingerprint = new Map();
    this.startedAt = null;
    this.actionLock = Promise.resolve();
    this.userActionInProgress = false;
    this.conversationCache = this.readConversationCache();
    // Cached pairing status so dashboard/readiness endpoints don't have to
    // acquire the (single) browser lock and queue behind in-flight sends.
    this.lastStatus = null;
    this.lastStatusAt = 0;
    // Hard cap on how long any single locked browser op may run. A wedged page
    // can otherwise hold the lock forever and stall the whole send queue.
    this.lockTimeoutMs = Number(config.lockTimeoutMs) || 70000;
    // How long ensurePaired() will wait through transient Google cookie-rotation
    // before giving up. Kept well under lockTimeoutMs so the watchdog still fires.
    this.pairedWaitMs = Number(config.pairedWaitMs) || 20000;
    // Background guard that closes Google's accounts.google.com/RotateCookiesPage
    // tab. When that tab's cookie rotation loops/stalls it wedges the whole
    // Messages session (page spins, every send hangs ~80s). Closing it keeps the
    // main page alive. Runs off the browser lock — it only touches OTHER pages.
    this.rotationTimer = null;
    this.rotationGuardMs = Number(config.rotationGuardMs) || 3000;
    // Grace period: give a freshly-opened RotateCookiesPage this long to finish
    // rotating cookies on its own before we force-close it. Letting legit
    // rotations complete can end Google's retry loop; we only kill STALLED tabs.
    this.rotationGraceMs = Number(config.rotationGraceMs) || 8000;
    this.rotationSeen = new WeakMap(); // page -> first-seen timestamp
  }

  async start() {
    return this.withBrowserLock(() => this.startUnlocked());
  }

  async startUnlocked() {
    if (this.page && !this.page.isClosed()) return this.page;

    fs.mkdirSync(this.config.userDataDir, { recursive: true });
    if (this.config.browserMode === "connect") {
      this.browser = await chromium.connectOverCDP(this.config.browserCdpUrl);
      this.context = this.browser.contexts()[0] || await this.browser.newContext();
    } else {
      this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
        headless: this.config.headless,
        executablePath: this.config.chromeExecutablePath || undefined,
        viewport: { width: 1280, height: 900 },
        args: [
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check"
        ]
      });
    }

    this.context.on("close", () => {
      this.page = null;
      this.context = null;
      this.stopPolling();
      this.stopRotationGuard();
    });
    this.browser?.on("disconnected", () => {
      this.browser = null;
      this.page = null;
      this.context = null;
      this.stopPolling();
      this.stopRotationGuard();
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    await this.page.goto(MESSAGES_URL, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    this.startedAt = new Date().toISOString();
    this.startPolling();
    this.startRotationGuard();
    return this.page;
  }

  async stop() {
    return this.withBrowserLock(() => this.stopUnlocked());
  }

  async stopUnlocked() {
    this.stopPolling();
    this.stopRotationGuard();
    if (this.config.browserMode === "connect") {
      if (this.browser) await this.browser.close();
    } else if (this.context) {
      await this.context.close();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async ensurePage() {
    if (!this.page || this.page.isClosed()) await this.startUnlocked();
    return this.page;
  }

  async status() {
    return this.withBrowserLock(() => this.statusUnlocked());
  }

  async statusUnlocked() {
    const page = await this.ensurePage();
    const title = await page.title().catch(() => "");
    const url = page.url();
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const hasStartChatText = /Start chat|New conversation|Start conversation/i.test(bodyText);
    const qrVisible = await this.isVisible([
      "img[alt*='QR' i]",
      "text=/QR code/i",
      "text=/Scan this QR/i",
      "text=/Scan the QR/i"
    ]);
    const signInVisible = await this.isVisible([
      "a[href*='accounts.google.com']",
      "button:has-text('Sign in with Google')"
    ]);
    const composeVisible = await this.isVisible([
      "[aria-label*='Start chat' i]",
      "[aria-label*='Start conversation' i]",
      "text=/Start chat/i",
      "text=/New conversation/i"
    ]);
    const onConversationsPage = /\/web\/conversations/.test(url);
    const paired = (onConversationsPage || composeVisible || hasStartChatText) && !qrVisible;
    const needsSignIn = !paired && signInVisible;

    const result = {
      running: Boolean(this.page && !this.page.isClosed()),
      browserMode: this.config.browserMode,
      startedAt: this.startedAt,
      url,
      title,
      paired,
      qrVisible,
      signInVisible: needsSignIn,
      hint: this.buildStatusHint(bodyText, qrVisible, paired, needsSignIn)
    };
    // Refresh the cache on every live status read (also done by the background
    // poller every cycle), so cache stays warm without extra lock contention.
    this.lastStatus = result;
    this.lastStatusAt = Date.now();
    return result;
  }

  // Last known status without touching the browser lock. null if never read.
  cachedStatus() {
    if (!this.lastStatus) return null;
    return { ...this.lastStatus, cached: true, ageMs: Date.now() - this.lastStatusAt };
  }

  // status() that can never block the caller longer than `ms`. The underlying
  // call keeps running (and will refresh the cache) even if we stop waiting.
  statusWithTimeout(ms = 5000) {
    return Promise.race([
      this.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("status_timeout")), ms))
    ]);
  }

  // Non-blocking status for dashboard/readiness. Serves a fresh-enough cache
  // immediately; otherwise tries a time-boxed live read; otherwise stale cache.
  async statusForDashboard({ maxAgeMs = 15000, timeoutMs = 5000 } = {}) {
    const cached = this.cachedStatus();
    if (cached) {
      // Always answer instantly from cache so the dashboard never blocks behind
      // in-flight sends. If the cache is getting old (the poller may be starved
      // during a send burst), kick a background refresh for the next read.
      if (cached.ageMs >= maxAgeMs) this.status().catch(() => {});
      return cached.ageMs >= maxAgeMs ? { ...cached, stale: true } : cached;
    }
    // Cold start only (no cache yet): time-boxed live read, never hangs.
    try {
      return await this.statusWithTimeout(timeoutMs);
    } catch {
      return {
        running: Boolean(this.page && !this.page.isClosed()),
        browserMode: this.config.browserMode,
        startedAt: this.startedAt,
        url: "",
        title: "",
        paired: false,
        qrVisible: false,
        signInVisible: false,
        hint: "status warming up (browser busy)"
      };
    }
  }

  buildStatusHint(bodyText, qrVisible, paired, signInVisible) {
    if (paired) return "paired";
    if (signInVisible) return "sign in to the controlled Chrome profile, then pair your phone";
    if (qrVisible) return "scan the QR code with Google Messages on your phone";
    if (/Use Messages for web|Messages for web|Scan/i.test(bodyText)) return "pairing screen";
    return "unknown page state";
  }

  async screenshot() {
    return this.withBrowserLock(() => this.screenshotUnlocked());
  }

  async screenshotUnlocked() {
    const page = await this.ensurePage();
    return page.screenshot({ fullPage: true, type: "png" });
  }

  async sendMessage({ to, text, onStage }) {
    return this.withBrowserLock(() => this.sendMessageUnlocked({ to, text, onStage }));
  }

  // Try, in order, to open the recipient's conversation. Returns true on success.
  // onStage reports which step is being attempted so the ledger can show progress.
  async openForSend(to, onStage) {
    const page = await this.ensurePage();

    // 1. Already viewing this recipient's conversation? Skip straight to send.
    const cached = this.getCachedRecipientConversation(to);
    if (cached?.href) {
      const convId = cached.href.split("/").pop();
      if (convId && page.url().includes(convId) && await this.composerReady(1200)) return true;
    }

    // 2. Existing conversation — find it in the sidebar and click it (SPA, no reload).
    onStage?.("locating");
    if (await this.openExistingConversation(to)) return true;

    // 3. New number — Start-chat UI flow.
    onStage?.("start_chat");
    if (await this.startChatFlow(to)) return true;

    // 4. Last resort — open the conversation by URL.
    onStage?.("open_by_url");
    if (await this.openConversationByUrl(to)) return true;

    return false;
  }

  async sendMessageUnlocked({ to, text, onStage }) {
    if (!to || !text) throw new Error("Both 'to' and 'text' are required.");
    const stage = (s) => { try { onStage?.(s); } catch { /* ignore */ } };

    const page = await this.ensurePage();
    await page.bringToFront().catch(() => {});
    stage("checking_paired");
    await this.ensurePaired();

    // GM web wedges mid-task (stuck on /conversations/new with no composer;
    // spontaneous reloads to the splash; an Enter that silently does nothing).
    // So the whole send — open, type, AND verify it actually left the composer —
    // is one retryable unit. On any failure we reload to a clean view and retry
    // (up to 3x). Before retyping we check the thread's last outgoing message, so
    // a reload-retry never double-sends a message that already went out.
    let sent = false;
    for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
      stage(attempt === 1 ? "opening" : `reload_retry_${attempt}`);
      const opened = await this.openForSend(to, stage).catch(() => false);

      if (opened) {
        // Dup-guard (retries only): a previous attempt may already have delivered
        // this text — if so, don't send it again.
        if (attempt > 1 && await this.lastOutgoingMatches(text)) { stage("already_sent"); sent = true; break; }
        stage("typing");
        sent = await this.typeAndSend(text).catch(() => false);
        if (sent) { stage("sent"); break; }
        stage("send_unverified");
      }

      // Not opened, or the send couldn't be verified — reload and retry.
      stage("stuck_reloading");
      await page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.waitForAppReady(9000);
      await this.ensurePaired().catch(() => {});
    }

    if (!sent) {
      stage("failed");
      const error = new Error(`Send to ${to} failed after 3 attempts (could not open or verify).`);
      error.statusCode = 502;
      throw error;
    }

    this.cacheRecipientConversation(to, page.url());

    const event = {
      type: "sent",
      to,
      text,
      at: new Date().toISOString()
    };
    this.emit("message:sent", event);
    return event;
  }

  // Resolves true once the real MESSAGE composer is present (a conversation is
  // open and ready to type into). Deliberately strict — the Start-chat recipient
  // box also matches a bare textarea/contenteditable, so we key on the
  // message-specific aria-label/placeholder to avoid a false "ready".
  async composerReady(timeout = 2000) {
    const page = await this.ensurePage();
    try {
      await page.waitForFunction(() => {
        return !!document.querySelector(
          "[aria-label*='Text message' i], textarea[aria-label*='message' i], textarea[placeholder*='message' i], [contenteditable='true'][aria-label*='message' i]"
        );
      }, null, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  // Open an EXISTING conversation by finding it in the sidebar and clicking it
  // (pure SPA navigation — no page reload, no fragile Start-chat flow). Tries the
  // already-rendered rows first (cheap), then lazy-scrolls the whole list so even
  // older customers are found. Returns false only for genuinely new numbers.
  async openExistingConversation(to) {
    const page = await this.ensurePage();

    // Shallow pass — recent customers are near the top, no scroll needed.
    let conversations = await this.listConversationsUnlocked(15);
    let match = conversations.find((c) => this.conversationMatchesRecipient(c, to));

    // Deep pass — scroll the sidebar to load the full history, then re-match.
    if (!match) {
      conversations = await this.listConversationsUnlocked(300);
      match = conversations.find((c) => this.conversationMatchesRecipient(c, to));
    }
    if (!match?.href) return false;

    // Already viewing it?
    const convId = match.href.split("/").pop();
    if (convId && page.url().includes(convId) && await this.composerReady(800)) {
      this.cacheRecipientConversation(to, match.href);
      return true;
    }

    const clicked = await this.clickConversationInSidebar(page, match.href);
    if (!clicked) return false;
    if (await this.composerReady(6000)) {
      this.cacheRecipientConversation(to, match.href);
      return true;
    }
    return false;
  }

  // Open a conversation purely through the "Start chat" UI — no page reload.
  // Works for ANY number regardless of whether it is visible in the sidebar.
  async startChatFlow(to) {
    const page = await this.ensurePage();
    try {
      // The Start-chat FAB is reachable from anywhere in the app (sidebar).
      await this.clickFirst([
        "[aria-label*='Start chat' i]",
        "[aria-label*='Start conversation' i]",
        "mws-fab",
        "text=/Start chat/i",
        "text=/New conversation/i"
      ], "start chat");

      const recipientInput = await this.locatorFirst([
        "input[placeholder*='name' i]",
        "input[placeholder*='phone' i]",
        "input[aria-label*='recipient' i]",
        "input[aria-label*='to' i]",
        "input[type='tel']",
        "input[type='text']"
      ]);
      await recipientInput.fill(to);
      await page.waitForTimeout(500); // let the "Send to <number>" / contact rows render

      // Commit the recipient by CLICKING the suggestion row (the reliable, human
      // way) — it returns true only once the composer actually opened. Enter is a
      // last-resort fallback for layouts where no row is clickable.
      if (await this.clickRecipientOption(to)) return true;
      await recipientInput.press("Enter").catch(() => {});
      return await this.composerReady(5000);
    } catch {
      return false;
    }
  }

  // Last resort: navigate to the conversation by URL (full page reload).
  // Uses the cached href, otherwise scans the conversation list once.
  async openConversationByUrl(to) {
    const page = await this.ensurePage();
    let href = this.getCachedRecipientConversation(to)?.href || null;
    if (!href) {
      const conversations = await this.listConversationsUnlocked(80);
      const match = conversations.find((c) => this.conversationMatchesRecipient(c, to));
      href = match?.href || null;
    }
    if (!href) return false;
    try {
      await page.goto(new URL(href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
      const ready = await this.composerReady(10000);
      if (ready) this.cacheRecipientConversation(to, href);
      return ready;
    } catch {
      this.deleteCachedRecipientConversation(to);
      return false;
    }
  }

  async waitForComposer(timeout = 10000) {
    const page = await this.ensurePage();
    await page.waitForFunction(() => {
      const text = document.body.innerText || "";
      return /Text message|SMS|MMS|RCS/i.test(text)
        || document.querySelector("[aria-label*='Text message' i], [aria-label*='Message' i], textarea, [contenteditable='true']");
    }, null, { timeout }).catch(() => {});
  }

  // Type the text into the REAL message composer (not the Start-chat recipient
  // box) and press Enter. Returns true only once we VERIFY the send actually
  // happened — GM clears the composer on a successful send, so an empty composer
  // (or our text appearing as the last outgoing bubble) confirms it. A silent
  // wedge (Enter does nothing) is reported as false so the caller can retry.
  async typeAndSend(text) {
    const page = await this.ensurePage();
    const messageInput = await this.locatorFirst([
      "[aria-label*='Text message' i]",
      "textarea[aria-label*='message' i]",
      "textarea[placeholder*='message' i]",
      "[contenteditable='true'][aria-label*='message' i]"
    ]);
    await messageInput.fill(text).catch(async () => {
      await messageInput.click();
      await page.keyboard.type(text);
    });
    await messageInput.press("Enter");

    // Verify: composer cleared OR our text is now the last outgoing message.
    try {
      await page.waitForFunction((sent) => {
        const el = document.querySelector(
          "[aria-label*='Text message' i], textarea[aria-label*='message' i], [contenteditable='true'][aria-label*='message' i]"
        );
        const composerEmpty = el ? ((el.value !== undefined ? el.value : el.textContent) || "").trim().length === 0 : false;
        const bubbles = document.querySelectorAll("mws-text-message-part");
        const last = bubbles[bubbles.length - 1];
        const lastText = last ? (last.innerText || last.textContent || "").replace(/\s+/g, " ").trim() : "";
        return composerEmpty || lastText === sent;
      }, text.replace(/\s+/g, " ").trim(), { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  // True if the most recent OUTGOING bubble in the open thread equals `text` —
  // used as a de-dupe guard before retyping on a reload-retry.
  async lastOutgoingMatches(text) {
    const page = await this.ensurePage();
    const want = text.replace(/\s+/g, " ").trim();
    try {
      return await page.evaluate((wanted) => {
        const out = [...document.querySelectorAll("mws-text-message-part")]
          .filter((n) => {
            const aria = n.getAttribute("aria-label") || "";
            const rect = n.getBoundingClientRect();
            return aria.startsWith("You said:") || rect.left > 720;
          });
        const last = out[out.length - 1];
        const t = last ? (last.innerText || last.textContent || "").replace(/\s+/g, " ").trim() : "";
        return t === wanted;
      }, want);
    } catch {
      return false;
    }
  }

  // Wait for the app shell (sidebar / composer) to be present after a load —
  // i.e. NOT sitting on the blue "Messages" splash. Used after reloads.
  async waitForAppReady(timeout = 9000) {
    const page = await this.ensurePage();
    await page.waitForFunction(() => {
      return !!document.querySelector(
        "mws-conversation-list-item, a[href*='/web/conversations/'], [aria-label*='Text message' i], [aria-label*='Start chat' i]"
      );
    }, null, { timeout }).catch(() => {});
  }

  async listConversations(limit = 20) {
    return this.withBrowserLock(() => this.listConversationsUnlocked(limit));
  }

  // The GM web sidebar lazy-loads conversations on scroll. Scroll the list
  // container down until we have `target` items rendered or no more load in.
  // Cheap when enough items are already present (the loop exits immediately).
  async loadConversationListItems(page, target) {
    await page.evaluate(async (want) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const countItems = () => document.querySelectorAll(
        "mws-conversation-list-item, a[href*='/web/conversations/']"
      ).length;

      // Find the scrollable ancestor that actually holds the conversation list.
      const findScroller = () => {
        const item = document.querySelector("mws-conversation-list-item, a[href*='/web/conversations/']");
        let node = item?.parentElement;
        while (node && node !== document.body) {
          const style = getComputedStyle(node);
          if ((style.overflowY === "auto" || style.overflowY === "scroll") &&
              node.scrollHeight > node.clientHeight + 4) {
            return node;
          }
          node = node.parentElement;
        }
        return null;
      };

      const scroller = findScroller();
      if (!scroller) return;

      let last = -1;
      let stalls = 0;
      // High iteration cap supports hundreds of conversations; the loop exits
      // early as soon as the list stops growing (with a small tolerance for
      // lazy-load lag).
      for (let i = 0; i < 250; i++) {
        if (countItems() >= want) break;
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(300);
        const now = countItems();
        if (now === last) {
          if (++stalls >= 2) break; // two no-growth cycles → reached the end
        } else {
          stalls = 0;
          last = now;
        }
      }
      scroller.scrollTop = 0; // restore the list to the top
    }, target).catch(() => {});
  }

  async listConversationsUnlocked(limit = 20) {
    const page = await this.ensurePage();
    if (!/\/web\/conversations/.test(page.url())) {
      await page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await page.waitForFunction(() => {
      const rows = [
        ...document.querySelectorAll("mws-conversation-list-item"),
        ...document.querySelectorAll("a[href*='/web/conversations/']")
      ];
      return rows.some((node) => {
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        return text.length > 2 && !/^Start chat$/i.test(text);
      });
    }, null, { timeout: 5000 }).catch(() => {});

    // Lazy-load more rows only when the caller wants a large list (dashboard,
    // recipient lookup). Polling (small limit) skips this to stay fast.
    if (limit > 15) {
      await this.loadConversationListItems(page, limit);
    }

    const rows = await page.evaluate((maxRows) => {
      const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
      const hrefOf = (node) => {
        const href = node?.getAttribute?.("href") || node?.querySelector?.("a[href]")?.getAttribute("href") || "";
        return href ? new URL(href, location.origin).pathname : "";
      };
      const directCandidates = [
        ...document.querySelectorAll("mws-conversation-list-item"),
        ...document.querySelectorAll("a[href*='/web/conversations/']"),
        ...document.querySelectorAll("[role='listitem']"),
        ...document.querySelectorAll("[data-e2e-conversation-list-item]")
      ];

      const mapRows = (candidates) => {
        const seen = new Set();
        return candidates
        .map((node, index) => {
          const text = textOf(node);
          const href = hrefOf(node);
          const title = textOf(node.querySelector?.("h2")) || text.split(" ").slice(0, 4).join(" ");
          const snippet = textOf(node.querySelector?.("mws-conversation-snippet"));
          const timestamp = textOf(node.querySelector?.("mws-relative-timestamp"));
          const id = href || text;
          const ariaLabel = node.getAttribute?.("aria-label") || "";
          let unreadCount = 0;
          let titleBold = false;
          const badgeEl = node.querySelector?.("mws-badge") ||
                          node.querySelector?.("[aria-label*='unread' i]");
          if (badgeEl) {
            const raw = (badgeEl.innerText || badgeEl.textContent || "").replace(/\D/g, "");
            unreadCount = raw.length <= 4 ? (parseInt(raw) || 0) : 0;
          }
          const titleEl = node.querySelector?.("h2");
          if (titleEl) {
            try {
              const fw = parseInt(window.getComputedStyle(titleEl).fontWeight);
              titleBold = fw >= 600;
            } catch {}
          }
          const snippetBold = (() => {
            const el = node.querySelector?.("mws-conversation-snippet");
            if (!el) return false;
            try { return parseInt(window.getComputedStyle(el).fontWeight) >= 600; } catch { return false; }
          })();
          const unread = unreadCount > 0 || /\bunread\b/i.test(ariaLabel) || titleBold || snippetBold;
          const pinned = node.innerHTML?.includes("push_pin") ||
                         /\bpinned\b/i.test(ariaLabel) ||
                         !!node.querySelector?.("[data-mat-icon-name='push_pin']");
          return {
            id,
            index,
            href,
            title,
            snippet,
            timestamp,
            text,
            unread,
            unreadCount,
            pinned
          };
        })
        .filter((row) => row.text && row.text.length > 2)
        .filter((row) => {
          if (seen.has(row.id)) return false;
          seen.add(row.id);
          return true;
        })
        .slice(0, maxRows);
      };

      const directRows = mapRows(directCandidates).filter((row) => !/^Start chat$/i.test(row.text));
      if (directRows.length > 0) return directRows;

      const sidebarRows = [...document.querySelectorAll("body *")]
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          return {
            id: `${Math.round(rect.top)}:${text}`,
            index,
            text,
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
          };
        })
        .filter((row) => row.text)
        .filter((row) => row.x >= 0 && row.x < 390 && row.y > 120)
        .filter((row) => row.width > 150 && row.width < 390)
        .filter((row) => row.height >= 38 && row.height <= 95)
        .filter((row) => !/^Start chat$/i.test(row.text))
        .filter((row) => !/^Google Messages$/i.test(row.text))
        .sort((a, b) => a.y - b.y || b.width - a.width);

      const seenBands = new Set();
      return sidebarRows
        .filter((row) => {
          const band = Math.round(row.y / 12);
          if (seenBands.has(band)) return false;
          seenBands.add(band);
          return true;
        })
        .slice(0, maxRows)
        .map(({ id, index, text }) => ({ id, index, href: "", title: text, snippet: "", timestamp: "", text }));
    }, limit);

    return rows;
  }

  async ensurePaired() {
    await this.closeRotationTabs().catch(() => {});
    const deadline = Date.now() + this.pairedWaitMs;
    let status = await this.statusUnlocked();
    while (!status.paired) {
      // Real blockers waiting can't fix → fail fast so the caller re-pairs.
      if (status.qrVisible || status.signInVisible) break;
      if (Date.now() >= deadline) break;
      // Transient: Google cookie rotation (accounts.google.com / RotateCookiesPage)
      // or a mid-load page where the composer hasn't rendered yet. Don't fail the
      // send — nudge back to conversations if parked on auth, then re-check. This
      // is what stops a brief rotation from draining the whole queue into failures.
      if (/accounts\.google\.com|RotateCookies/i.test(status.url)) {
        await this.page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      await this.page.waitForTimeout(1000).catch(() => {});
      status = await this.statusUnlocked();
    }
    if (!status.paired) {
      const error = new Error(`Google Messages is not ready: ${status.hint}`);
      error.statusCode = 409;
      error.details = status;
      throw error;
    }
  }

  async openConversation(query) {
    return this.withBrowserLock(() => this.openConversationUnlocked(query));
  }

  async openConversationUnlocked(query = {}) {
    const page = await this.ensurePage();
    await this.ensurePaired();

    const hrefToOpen = query.href || null;

    if (hrefToOpen) {
      // Already on this conversation? Nothing to do.
      const convId = hrefToOpen.split("/").pop();
      if (page.url().includes(convId)) {
        return { opened: true, conversation: { href: hrefToOpen, id: hrefToOpen, title: query.title || "" } };
      }

      // Prefer SPA click (fast) over full page navigation (slow)
      const clicked = await this.clickConversationInSidebar(page, hrefToOpen);
      if (!clicked) {
        // Sidebar link not visible — fall back to full navigation
        await page.goto(new URL(hrefToOpen, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      return { opened: true, conversation: { href: hrefToOpen, id: hrefToOpen, title: query.title || "" } };
    }

    const conversations = await this.listConversationsUnlocked(100);
    const match = this.findConversation(conversations, query);
    if (!match) {
      const error = new Error("Conversation not found.");
      error.statusCode = 404;
      error.details = { query };
      throw error;
    }

    if (match.href) {
      const clicked = await this.clickConversationInSidebar(page, match.href);
      if (!clicked) {
        await page.goto(new URL(match.href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    } else {
      await page.getByText(match.title || match.text, { exact: false }).first().click();
    }

    return { opened: true, conversation: match };
  }

  async clickConversationInSidebar(page, href) {
    const convId = href.split("/").pop();
    try {
      const link = page.locator(`a[href*="${convId}"]`).first();
      const visible = await link.isVisible({ timeout: 1500 });
      if (!visible) return false;
      await link.click();
      return true;
    } catch {
      return false;
    }
  }

  async waitForMessages(timeout = 8000) {
    const page = await this.ensurePage();
    await page.waitForFunction(
      () => document.querySelector("mws-text-message-part, mws-tombstone-message-wrapper"),
      null, { timeout }
    ).catch(() => {});
  }

  findConversation(conversations, query) {
    if (Number.isInteger(query.index)) return conversations[query.index] || null;
    if (query.href) return conversations.find((row) => row.href === query.href || row.id === query.href) || null;
    if (query.id) return conversations.find((row) => row.id === query.id || row.href === query.id) || null;
    if (query.title) {
      const title = query.title.toLowerCase();
      return conversations.find((row) => row.title.toLowerCase() === title)
        || conversations.find((row) => row.title.toLowerCase().includes(title));
    }
    return null;
  }

  conversationMatchesRecipient(conversation, to) {
    const haystack = this.normalizePhone(conversation.text || `${conversation.title} ${conversation.snippet}`);
    return this.phoneVariants(to).some((variant) => variant.length >= 7 && haystack.includes(variant));
  }

  normalizePhone(value) {
    return String(value || "").replace(/\D/g, "");
  }

  phoneVariants(value) {
    const digits = this.normalizePhone(value);
    const variants = new Set([digits]);
    if (digits.startsWith("98")) variants.add(`0${digits.slice(2)}`);
    if (digits.startsWith("0")) variants.add(`98${digits.slice(1)}`);
    if (digits.length > 10) variants.add(digits.slice(-10));
    return [...variants].filter(Boolean);
  }

  recipientCacheKey(to) {
    return this.phoneVariants(to).sort((a, b) => b.length - a.length)[0] || String(to);
  }

  readConversationCache() {
    try {
      if (!fs.existsSync(this.config.conversationCacheFile)) return { recipients: {} };
      return JSON.parse(fs.readFileSync(this.config.conversationCacheFile, "utf8"));
    } catch {
      return { recipients: {} };
    }
  }

  writeConversationCache() {
    fs.mkdirSync(path.dirname(this.config.conversationCacheFile), { recursive: true });
    fs.writeFileSync(this.config.conversationCacheFile, JSON.stringify(this.conversationCache, null, 2));
  }

  getCachedRecipientConversation(to) {
    return this.conversationCache.recipients?.[this.recipientCacheKey(to)] || null;
  }

  cacheRecipientConversation(to, hrefOrUrl, title = "") {
    const parsedUrl = new URL(hrefOrUrl, MESSAGES_URL);
    if (!parsedUrl.pathname.includes("/web/conversations/")) return;
    this.conversationCache.recipients ||= {};
    this.conversationCache.recipients[this.recipientCacheKey(to)] = {
      href: parsedUrl.pathname,
      title,
      updatedAt: new Date().toISOString()
    };
    this.writeConversationCache();
  }

  deleteCachedRecipientConversation(to) {
    if (!this.conversationCache.recipients) return;
    delete this.conversationCache.recipients[this.recipientCacheKey(to)];
    this.writeConversationCache();
  }

  // Click a recipient suggestion to actually OPEN the conversation. GM shows a
  // "Send to <number>" row and (if known) a contact row — clicking either opens
  // the thread. We try each, and only return true once the message composer is
  // really present, so a click that didn't commit is treated as a miss.
  async clickRecipientOption(to) {
    const page = await this.ensurePage();
    const local = to.replace(/^\+98/, "0");
    // Most specific first: the exact "Send to <number>" row, then any suggestion
    // row that contains the number (contact match), then the bare number text.
    const selectors = [
      `text=Send to ${to}`,
      `text=Send to ${local}`,
      `[role='option']:has-text("${to}")`,
      `[role='listitem']:has-text("${to}")`,
      `[role='option']:has-text("${local}")`,
      `mws-contact-selection-list :has-text("${to}")`,
      `text=${to}`,
      `text=${local}`
    ];

    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: "visible", timeout: 1500 });
        await loc.click({ timeout: 1500 });
        if (await this.composerReady(5000)) return true; // confirmed: thread opened
      } catch {
        // Not this row — try the next.
      }
    }
    return false;
  }

  async extractMessagesFromPage(page, limit) {
    await page.waitForFunction(() => {
      const body = document.body.innerText || "";
      const loaded = !/Loading messages/i.test(body);
      return loaded && document.querySelector("mws-text-message-part, mws-tombstone-message-wrapper");
    }, null, { timeout: 8000 }).catch(() => {});

    return page.evaluate((maxRows) => {
      const directCandidates = [
        ...document.querySelectorAll("mws-text-message-part"),
        ...document.querySelectorAll("mws-tombstone-message-wrapper")
      ];
      const fallbackCandidates = [...document.querySelectorAll("body *")]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left > 340 && rect.top > 130 && rect.top < window.innerHeight - 80
            && rect.width > 8 && rect.width < 850 && rect.height > 8 && rect.height < 180;
        });
      const candidates = directCandidates.length ? directCandidates : fallbackCandidates;
      return candidates
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const tag = node.tagName.toLowerCase();
          const aria = node.getAttribute("aria-label") || "";
          const type = tag === "mws-tombstone-message-wrapper" ? "timestamp" : "message";
          const dirFromAria = aria.startsWith("You said:") ? "out" : aria.includes(" said:") ? "in" : "";
          const direction = dirFromAria || (type !== "timestamp" ? (Math.round(rect.left) > 720 ? "out" : "in") : "");
          return {
            index,
            type,
            direction,
            aria,
            text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
            x: Math.round(rect.left),
            y: Math.round(rect.top)
          };
        })
        .filter((row) => row.text)
        .filter((row) => !/^Text message/i.test(row.text))
        .filter((row) => !/^(SMS|MMS|RCS)$/i.test(row.text))
        .filter((row) => !/^\d+$/.test(row.text))
        .filter((row) => !/^0 new messages$/i.test(row.text))
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .filter((row, idx, rows) => rows.findIndex((other) => other.text === row.text && Math.abs(other.y - row.y) < 4) === idx)
        .map(({ index, type, direction, text, aria }) => ({ index, type, direction, text, aria }))
        .slice(-maxRows);
    }, limit);
  }

  async getActiveConversationMessages(limit = 50) {
    return this.withBrowserLock(() => this.getActiveConversationMessagesUnlocked(limit));
  }

  async getActiveConversationMessagesUnlocked(limit = 50) {
    const page = await this.ensurePage();
    return this.extractMessagesFromPage(page, limit);
  }

  async getConversationMessages(query, limit = 50) {
    this.userActionInProgress = true;
    try {
      return await this.withBrowserLock(async () => {
        const opened = await this.openConversationUnlocked(query);
        const messages = await this.getActiveConversationMessagesUnlocked(limit);
        return { conversation: opened.conversation, messages };
      });
    } finally {
      this.userActionInProgress = false;
    }
  }

  async debugSidebarElements(limit = 80) {
    return this.withBrowserLock(() => this.debugSidebarElementsUnlocked(limit));
  }

  async debugSidebarElementsUnlocked(limit = 80) {
    const page = await this.ensurePage();
    return page.evaluate((maxRows) => {
      return [...document.querySelectorAll("body *")]
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          return {
            index,
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute("role") || "",
            aria: node.getAttribute("aria-label") || "",
            text,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        })
        .filter((row) => row.text || row.aria)
        .filter((row) => row.x >= 0 && row.x < 430 && row.y >= 0)
        .slice(0, maxRows);
    }, limit);
  }

  async debugMainElements(limit = 120) {
    return this.withBrowserLock(async () => {
      const page = await this.ensurePage();
      return page.evaluate((maxRows) => {
        return [...document.querySelectorAll("body *")]
          .map((node, index) => {
            const rect = node.getBoundingClientRect();
            const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
            return {
              index,
              tag: node.tagName.toLowerCase(),
              role: node.getAttribute("role") || "",
              aria: node.getAttribute("aria-label") || "",
              text,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
          })
          .filter((row) => row.text || row.aria)
          .filter((row) => row.x > 330 && row.y > 70)
          .slice(0, maxRows);
      }, limit);
    });
  }

  startPolling() {
    if (this.config.pollIntervalMs <= 0) return;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollConversations().catch((error) => {
        this.emit("error", error);
      });
    }, this.config.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // Close Google's accounts.google.com/RotateCookiesPage tab(s). That tab is
  // opened by Google to rotate session cookies; when its rotation stalls it
  // wedges the Messages session (page spins, sends hang). We don't need it —
  // closing it lets the main page keep working. Touches only OTHER pages, so it
  // is safe to run without the browser lock.
  // force=true closes any rotation tab immediately (used during recovery when the
  // session is already wedged). Otherwise a fresh rotation tab gets rotationGraceMs
  // to complete on its own; only a stalled tab (open past the grace) is closed.
  async closeRotationTabs(force = false) {
    const browser = this.browser;
    const context = this.context;
    if (!browser && !context) return 0;
    const contexts = browser ? browser.contexts() : [context];
    let closed = 0;
    const now = Date.now();
    for (const ctx of contexts) {
      let pages = [];
      try { pages = ctx.pages(); } catch { continue; }
      for (const pg of pages) {
        if (pg === this.page) continue;
        let url = "";
        try { url = pg.url() || ""; } catch { continue; }
        if (!/accounts\.google\.com\/RotateCookies/i.test(url)) continue;
        if (force) {
          await pg.close().catch(() => {});
          closed += 1;
          continue;
        }
        const seen = this.rotationSeen.get(pg);
        if (seen === undefined) {
          // First sighting — start the grace clock, let rotation try to finish.
          this.rotationSeen.set(pg, now);
          continue;
        }
        if (now - seen >= this.rotationGraceMs) {
          await pg.close().catch(() => {});
          closed += 1;
        }
      }
    }
    return closed;
  }

  startRotationGuard() {
    if (this.rotationTimer || this.rotationGuardMs <= 0) return;
    this.rotationTimer = setInterval(() => {
      this.closeRotationTabs().catch(() => {});
    }, this.rotationGuardMs);
    this.rotationTimer.unref?.();
  }

  stopRotationGuard() {
    if (!this.rotationTimer) return;
    clearInterval(this.rotationTimer);
    this.rotationTimer = null;
  }

  async pollConversations() {
    if (!this.page || this.page.isClosed()) return;
    if (this.userActionInProgress) return; // user action has priority — skip this cycle
    await this.withBrowserLock(async () => {
      if (this.userActionInProgress) return; // re-check after acquiring lock
      const status = await this.statusUnlocked();
      if (!status.paired || this.userActionInProgress) return;

      const conversations = await this.listConversationsUnlocked(10);
      for (const conversation of conversations) {
        const previous = this.lastConversationFingerprint.get(conversation.id);
        if (previous && previous !== conversation.text) {
          const event = {
            type: "conversation_changed",
            conversation,
            previousText: previous,
            at: new Date().toISOString()
          };
          this.emit("conversation:changed", event);
        }
        this.lastConversationFingerprint.set(conversation.id, conversation.text);
      }
    });
  }

  async locatorFirst(selectors) {
    const page = await this.ensurePage();
    return new Promise((resolve, reject) => {
      let done = false;
      let pending = selectors.length;
      const missed = [];
      for (const selector of selectors) {
        const loc = page.locator(selector).first();
        loc.waitFor({ state: "visible", timeout: 5000 })
          .then(() => { if (!done) { done = true; resolve(loc); } })
          .catch((err) => {
            missed.push(selector);
            if (--pending === 0 && !done) {
              reject(new Error(`Element not found. Tried: ${missed.join(", ")}`));
            }
          });
      }
    });
  }

  async clickFirst(selectors, label) {
    const locator = await this.locatorFirst(selectors);
    await locator.click();
    return { clicked: label };
  }

  async clickOptional(selectors) {
    for (const selector of selectors) {
      try {
        const locator = await this.locatorFirst([selector]);
        await locator.click();
        return true;
      } catch {
        // Try the next selector.
      }
    }
    return false;
  }

  async isVisible(selectors) {
    const page = await this.ensurePage();
    for (const selector of selectors) {
      try {
        if (await page.locator(selector).first().isVisible({ timeout: 1000 })) return true;
      } catch {
        // Try the next selector.
      }
    }
    return false;
  }

  async withBrowserLock(action, { timeoutMs = this.lockTimeoutMs } = {}) {
    const previous = this.actionLock;
    let release;
    this.actionLock = new Promise((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      if (!timeoutMs) return await action();
      // Watchdog: never hold the lock longer than timeoutMs. If the action
      // wedges, reject so the lock frees and the queue keeps moving. The
      // orphaned action is abandoned; the worker triggers recover() on repeated
      // failures to rebuild a clean page.
      let timer;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser_lock_timeout")), timeoutMs);
      });
      try {
        return await Promise.race([action(), guard]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
  }

  // Drop the current (possibly wedged) page and reconnect to the external
  // Chrome with a fresh Messages page. Does NOT kill the Chrome process.
  async recover() {
    return this.withBrowserLock(async () => {
      this.stopPolling();
      // Session is wedged — force-close any rotation tab immediately (skip grace).
      await this.closeRotationTabs(true).catch(() => {});
      // In connect mode the browser process is owned by gmweb-chrome.service;
      // just drop our refs and reconnect rather than closing it.
      this.browser = null;
      this.context = null;
      this.page = null;
      await this.startUnlocked();
      return { recovered: true, at: new Date().toISOString() };
    }, { timeoutMs: 60000 });
  }
}

module.exports = {
  GoogleMessagesClient
};
