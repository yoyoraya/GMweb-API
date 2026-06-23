const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const LOG_KEEP = 5000;
const TOKEN_BYTES = 32; // 256-bit token = computationally infeasible to brute-force SHA-256

// Constant-time comparison to prevent timing attacks
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Hash a plaintext token for safe storage
function hashToken(plaintext) {
  return crypto.createHash("sha256").update(plaintext).digest("base64url");
}

class ApiKeyStore {
  constructor(keysFile, logsFile) {
    this.keysFile = keysFile;
    this.logsFile = logsFile;
    this.keys = {};
    // In-memory rate buckets: tokenHash -> { sends: [{ts}], authFails: [{ts}] }
    this.rateBuckets = new Map();
  }

  async load() {
    try {
      const text = await fs.readFile(this.keysFile, "utf8");
      const parsed = JSON.parse(text) || {};
      // Migrate legacy plaintext tokens to hashed form on load
      let dirty = false;
      for (const [id, key] of Object.entries(parsed)) {
        if (key.token && !key.tokenHash) {
          key.tokenHash = hashToken(key.token);
          key.tokenPreviewStored = key.token.slice(0, 8) + "...";
          delete key.token;
          dirty = true;
        }
      }
      this.keys = parsed;
      if (dirty) this.save();
    } catch {
      this.keys = {};
    }
  }

  save() {
    // Ensure token plaintext is NEVER written to disk
    const safe = {};
    for (const [id, key] of Object.entries(this.keys)) {
      const { token, ...rest } = key; // strip plaintext if somehow present
      safe[id] = rest;
    }
    fs.writeFile(this.keysFile, JSON.stringify(safe, null, 2), "utf8").catch(() => {});
  }

  create({ name, allowedIps = [], rateLimit = {} }) {
    const id = crypto.randomBytes(8).toString("hex");
    const plaintext = `gmw_${crypto.randomBytes(TOKEN_BYTES).toString("base64url")}`;
    const tokenHash = hashToken(plaintext);
    this.keys[id] = {
      tokenHash,                     // SHA-256 of token — safe to store
      tokenPreviewStored: `${plaintext.slice(0, 8)}...`,
      name: String(name || "").slice(0, 64) || "Unnamed",
      allowedIps: Array.isArray(allowedIps) ? allowedIps.map(String).slice(0, 30) : [],
      // Rate limits for /send: maxPerMinute and maxPerHour (0 = unlimited)
      sendRateMinute: Math.max(0, Number.isFinite(rateLimit.minute) ? rateLimit.minute : 10),
      sendRateHour:   Math.max(0, Number.isFinite(rateLimit.hour)   ? rateLimit.hour   : 100),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      requestCount: 0,
      enabled: true
    };
    this.save();
    // Return plaintext ONCE — never stored on disk after this
    return { id, token: plaintext, ...this.publicView(id, this.keys[id]) };
  }

  rotate(id) {
    if (!this.keys[id]) return null;
    const plaintext = `gmw_${crypto.randomBytes(TOKEN_BYTES).toString("base64url")}`;
    this.keys[id].tokenHash = hashToken(plaintext);
    this.keys[id].tokenPreviewStored = `${plaintext.slice(0, 8)}...`;
    this.save();
    return { id, token: plaintext, ...this.publicView(id, this.keys[id]) };
  }

  update(id, patch) {
    if (!this.keys[id]) return null;
    if (patch.name !== undefined) this.keys[id].name = String(patch.name).slice(0, 64);
    if (patch.allowedIps !== undefined) {
      this.keys[id].allowedIps = Array.isArray(patch.allowedIps)
        ? patch.allowedIps.map(String).slice(0, 30) : [];
    }
    if (patch.enabled !== undefined) this.keys[id].enabled = Boolean(patch.enabled);
    if (patch.sendRateMinute !== undefined) this.keys[id].sendRateMinute = Math.max(0, Number(patch.sendRateMinute) || 0);
    if (patch.sendRateHour !== undefined) this.keys[id].sendRateHour = Math.max(0, Number(patch.sendRateHour) || 0);
    this.save();
    return this.publicView(id, this.keys[id]);
  }

  delete(id) {
    if (!this.keys[id]) return false;
    delete this.keys[id];
    this.rateBuckets.delete(id);
    this.save();
    return true;
  }

  // Find key by plaintext token using constant-time hash comparison
  findByToken(plaintext) {
    if (!plaintext) return null;
    const incoming = hashToken(plaintext);
    for (const [id, key] of Object.entries(this.keys)) {
      if (!key.enabled) continue;
      if (!key.tokenHash) continue;
      if (safeEqual(incoming, key.tokenHash)) return { id, ...key };
    }
    return null;
  }

  isIpAllowed(key, ip) {
    if (!key.allowedIps || key.allowedIps.length === 0) return true;
    const norm = (ip || "").replace(/^::ffff:/, "");
    return key.allowedIps.some((a) => a === norm || a === ip);
  }

  // Check and update send rate limit for a key.
  // Returns { allowed: bool, minuteLeft: n, hourLeft: n }
  checkSendRate(id) {
    const key = this.keys[id];
    if (!key) return { allowed: false };
    const now = Date.now();
    let bucket = this.rateBuckets.get(id);
    if (!bucket) {
      bucket = { sends: [] };
      this.rateBuckets.set(id, bucket);
    }
    // Prune old entries
    bucket.sends = bucket.sends.filter((ts) => now - ts < 3600_000);
    const inLastMinute = bucket.sends.filter((ts) => now - ts < 60_000).length;
    const inLastHour   = bucket.sends.length;
    const minuteOk = key.sendRateMinute === 0 || inLastMinute < key.sendRateMinute;
    const hourOk   = key.sendRateHour   === 0 || inLastHour   < key.sendRateHour;
    if (minuteOk && hourOk) {
      bucket.sends.push(now);
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: !minuteOk ? "per_minute_limit" : "per_hour_limit",
      minuteUsed: inLastMinute,
      hourUsed: inLastHour,
      limits: { minute: key.sendRateMinute, hour: key.sendRateHour }
    };
  }

  recordUse(id) {
    if (!this.keys[id]) return;
    this.keys[id].lastUsedAt = new Date().toISOString();
    this.keys[id].requestCount = (this.keys[id].requestCount || 0) + 1;
    this.save();
  }

  publicView(id, key) {
    return {
      id,
      name: key.name,
      allowedIps: key.allowedIps,
      sendRateMinute: key.sendRateMinute,
      sendRateHour: key.sendRateHour,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      requestCount: key.requestCount || 0,
      enabled: key.enabled,
      tokenPreview: key.tokenPreviewStored || "gmw_..."
    };
  }

  list() {
    return Object.entries(this.keys).map(([id, key]) => this.publicView(id, key));
  }

  async appendLog(entry) {
    try {
      await fs.appendFile(this.logsFile, JSON.stringify(entry) + "\n", "utf8");
      if ((entry.count || 0) % 200 === 0) this.trimLogs().catch(() => {});
    } catch { /* disk error */ }
  }

  async trimLogs() {
    try {
      const text = await fs.readFile(this.logsFile, "utf8");
      const lines = text.split("\n").filter(Boolean);
      if (lines.length > LOG_KEEP) {
        await fs.writeFile(this.logsFile, lines.slice(-LOG_KEEP).join("\n") + "\n", "utf8");
      }
    } catch { /* ignore */ }
  }

  async getLogs({ limit = 100, keyId } = {}) {
    try {
      const text = await fs.readFile(this.logsFile, "utf8");
      const lines = text.split("\n").filter(Boolean);
      const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const filtered = keyId ? entries.filter((e) => e.keyId === keyId) : entries;
      return filtered.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
}

module.exports = { ApiKeyStore };
