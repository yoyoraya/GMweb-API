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
    this.conversationCache = this.readConversationCache();
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
    });
    this.browser?.on("disconnected", () => {
      this.browser = null;
      this.page = null;
      this.context = null;
      this.stopPolling();
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    await this.page.goto(MESSAGES_URL, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    this.startedAt = new Date().toISOString();
    this.startPolling();
    return this.page;
  }

  async stop() {
    return this.withBrowserLock(() => this.stopUnlocked());
  }

  async stopUnlocked() {
    this.stopPolling();
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

    return {
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

  async sendMessage({ to, text }) {
    return this.withBrowserLock(() => this.sendMessageUnlocked({ to, text }));
  }

  async sendMessageUnlocked({ to, text }) {
    if (!to || !text) throw new Error("Both 'to' and 'text' are required.");
    const page = await this.ensurePage();
    await page.bringToFront().catch(() => {});
    await this.ensurePaired();

    const openedExisting = await this.openConversationForRecipient(to);
    if (!openedExisting) {
      await this.startNewConversation(to);
    }

    await this.typeAndSend(text);

    this.cacheRecipientConversation(to, page.url());

    const event = {
      type: "sent",
      to,
      text,
      fastPath: openedExisting,
      at: new Date().toISOString()
    };
    this.emit("message:sent", event);
    return event;
  }

  async openConversationForRecipient(to) {
    const page = await this.ensurePage();
    const cached = this.getCachedRecipientConversation(to);
    if (cached?.href) {
      try {
        const targetUrl = new URL(cached.href, MESSAGES_URL).toString();
        if (page.url() === targetUrl) {
          await this.waitForComposer(3000);
          return true;
        }
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await this.waitForComposer(8000);
        return true;
      } catch {
        this.deleteCachedRecipientConversation(to);
      }
    }

    const conversations = await this.listConversationsUnlocked(80);
    const match = conversations.find((conversation) => this.conversationMatchesRecipient(conversation, to));
    if (!match?.href) return false;

    await page.goto(new URL(match.href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
    await this.waitForComposer(10000);
    this.cacheRecipientConversation(to, match.href, match.title);
    return true;
  }

  async startNewConversation(to) {
    const page = await this.ensurePage();
    await page.goto(`${MESSAGES_URL}/conversations`, { waitUntil: "domcontentloaded" }).catch(() => {});

    await this.clickFirst([
      "[aria-label*='Start chat' i]",
      "[aria-label*='Start conversation' i]",
      "text=/Start chat/i",
      "text=/New conversation/i",
      "mws-fab"
    ], "start chat");

    const recipientInput = await this.locatorFirst([
      "input[placeholder*='name' i]",
      "input[placeholder*='phone' i]",
      "input[aria-label*='recipient' i]",
      "input[aria-label*='to' i]",
      "input[type='text']"
    ]);
    await recipientInput.fill(to);
    await page.keyboard.press("Enter");

    await page.waitForTimeout(500);
    await this.clickRecipientOption(to);
    await this.waitForComposer(8000);
  }

  async waitForComposer(timeout = 10000) {
    const page = await this.ensurePage();
    await page.waitForFunction(() => {
      const text = document.body.innerText || "";
      return /Text message|SMS|MMS|RCS/i.test(text)
        || document.querySelector("[aria-label*='Text message' i], [aria-label*='Message' i], textarea, [contenteditable='true']");
    }, null, { timeout }).catch(() => {});
  }

  async typeAndSend(text) {
    const page = await this.ensurePage();
    const messageInput = await this.locatorFirst([
      "[aria-label*='Text message' i]",
      "[aria-label*='Message' i]",
      "textarea[aria-label*='message' i]",
      "textarea[placeholder*='message' i]",
      "[contenteditable='true'][aria-label*='message' i]",
      "[contenteditable='true']",
      "textarea"
    ]);
    await messageInput.fill(text).catch(async () => {
      await messageInput.click();
      await page.keyboard.type(text);
    });

    const sendClicked = await this.clickOptional([
      "[aria-label^='Send' i]",
      "button[aria-label*='Send' i]",
      "text=/^Send$/i"
    ]);
    if (!sendClicked) await page.keyboard.press("Enter");
  }

  async listConversations(limit = 20) {
    return this.withBrowserLock(() => this.listConversationsUnlocked(limit));
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
    }, null, { timeout: 15000 }).catch(() => {});

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
                          node.querySelector?.("[class*='unread']") ||
                          node.querySelector?.("[aria-label*='unread' i]");
          if (badgeEl) {
            unreadCount = parseInt((badgeEl.innerText || badgeEl.textContent || "").replace(/\D/g, "")) || 0;
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
          return {
            id,
            index,
            href,
            title,
            snippet,
            timestamp,
            text,
            unread,
            unreadCount
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
    const status = await this.statusUnlocked();
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

    const conversations = await this.listConversationsUnlocked(100);
    const match = this.findConversation(conversations, query);
    if (!match) {
      const error = new Error("Conversation not found.");
      error.statusCode = 404;
      error.details = { query };
      throw error;
    }

    if (match.href) {
      await page.goto(new URL(match.href, MESSAGES_URL).toString(), { waitUntil: "domcontentloaded" });
    } else {
      await page.getByText(match.title || match.text, { exact: false }).first().click();
    }

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return {
      opened: true,
      conversation: match
    };
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

  async clickRecipientOption(to) {
    const page = await this.ensurePage();
    const normalizedLocal = to.replace(/^\+98/, "0");
    const candidates = [
      `Send to ${to}`,
      to,
      normalizedLocal
    ];

    for (const candidate of candidates) {
      try {
        await page.getByText(candidate, { exact: false }).first().click({ timeout: 2000 });
        return true;
      } catch {
        // Try the next visible recipient label.
      }
    }

    await page.keyboard.press("Enter");
    return false;
  }

  async getActiveConversationMessages(limit = 50) {
    return this.withBrowserLock(() => this.getActiveConversationMessagesUnlocked(limit));
  }

  async getActiveConversationMessagesUnlocked(limit = 50) {
    const page = await this.ensurePage();
    await page.waitForFunction(() => {
      const body = document.body.innerText || "";
      const loaded = !/Loading messages/i.test(body);
      return loaded && document.querySelector("mws-text-message-part, mws-tombstone-message-wrapper");
    }, null, { timeout: 20000 }).catch(() => {});

    return page.evaluate((maxRows) => {
      const directCandidates = [
        ...document.querySelectorAll("mws-text-message-part"),
        ...document.querySelectorAll("mws-tombstone-message-wrapper")
      ];

      const fallbackCandidates = [...document.querySelectorAll("body *")]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left > 340
            && rect.top > 130
            && rect.top < window.innerHeight - 80
            && rect.width > 8
            && rect.width < 850
            && rect.height > 8
            && rect.height < 180;
        });

      const candidates = directCandidates.length ? directCandidates : fallbackCandidates;

      return candidates
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const tag = node.tagName.toLowerCase();
          const aria = node.getAttribute("aria-label") || "";
          const type = tag === "mws-tombstone-message-wrapper" ? "timestamp" : "message";
          const direction = aria.startsWith("You said:") ? "out" : aria.includes(" said:") ? "in" : "";
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
        .filter((row, index, rows) => rows.findIndex((other) => other.text === row.text && Math.abs(other.y - row.y) < 4) === index)
        .map(({ index, type, direction, text, aria }) => ({ index, type, direction, text, aria }))
        .slice(-maxRows);
    }, limit);
  }

  async getConversationMessages(query, limit = 50) {
    return this.withBrowserLock(async () => {
      const opened = await this.openConversationUnlocked(query);
      const messages = await this.getActiveConversationMessagesUnlocked(limit);
      return {
        conversation: opened.conversation,
        messages
      };
    });
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

  async pollConversations() {
    if (!this.page || this.page.isClosed()) return;
    await this.withBrowserLock(async () => {
      const status = await this.statusUnlocked();
      if (!status.paired) return;

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
    const errors = [];
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        await locator.waitFor({ state: "visible", timeout: 5000 });
        return locator;
      } catch (error) {
        errors.push(`${selector}: ${error.message.split("\n")[0]}`);
      }
    }
    throw new Error(`Could not find element. Tried: ${errors.join(" | ")}`);
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

  async withBrowserLock(action) {
    const previous = this.actionLock;
    let release;
    this.actionLock = new Promise((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
    }
  }
}

module.exports = {
  GoogleMessagesClient
};
