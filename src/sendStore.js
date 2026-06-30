const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Durable send ledger (SQLite). Survives API/Redis/Chrome crashes, so we never
// lose track of what was queued or sent. It powers three things:
//   1. Status tracking per message (queued → active → sent | failed | suppressed).
//   2. 24h content de-dupe — the same {to,text} is not re-sent within the window,
//      even if a consumer (Eve) posts it again or Redis is wiped.
//   3. Crash recovery — on boot, unfinished rows are re-enqueued so the queue is
//      rebuilt from the ledger, not lost.
//
// WAL mode + synchronous=NORMAL gives crash-safe durability with good throughput.

function dedupeKey(to, text) {
  return crypto.createHash("sha256").update(`${to}\n${text}`).digest("hex");
}

class SendStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sends (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key  TEXT NOT NULL,
        to_number   TEXT NOT NULL,
        text        TEXT NOT NULL,
        key_name    TEXT,
        job_id      TEXT,
        status      TEXT NOT NULL,           -- queued | active | sent | failed | suppressed
        attempts    INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        sent_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sends_dedupe  ON sends (dedupe_key, status, sent_at);
      CREATE INDEX IF NOT EXISTS idx_sends_job     ON sends (job_id);
      CREATE INDEX IF NOT EXISTS idx_sends_status  ON sends (status);
    `);

    this._insert = this.db.prepare(
      `INSERT INTO sends (dedupe_key, to_number, text, key_name, status, created_at, updated_at)
       VALUES (@dedupe_key, @to_number, @text, @key_name, 'queued', @now, @now)`
    );
    this._lastSent = this.db.prepare(
      `SELECT * FROM sends WHERE dedupe_key=? AND status='sent' AND sent_at > ? ORDER BY sent_at DESC LIMIT 1`
    );
    this._inflight = this.db.prepare(
      `SELECT * FROM sends WHERE dedupe_key=? AND status IN ('queued','active') ORDER BY created_at DESC LIMIT 1`
    );
    this._attach = this.db.prepare(`UPDATE sends SET job_id=?, updated_at=? WHERE id=?`);
    this._setById = this.db.prepare(`UPDATE sends SET status=?, error=?, updated_at=? WHERE id=?`);
    this._byJob = this.db.prepare(`SELECT * FROM sends WHERE job_id=? ORDER BY id DESC LIMIT 1`);
    this._setStatusByJob = this.db.prepare(
      `UPDATE sends SET status=@status, attempts=@attempts, error=@error, updated_at=@now,
         sent_at = CASE WHEN @status='sent' THEN @now ELSE sent_at END
       WHERE job_id=@job_id`
    );
    this._pending = this.db.prepare(
      `SELECT * FROM sends WHERE status IN ('queued','active') ORDER BY created_at ASC`
    );
    this._statsRows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM sends GROUP BY status`);
    this._recent = this.db.prepare(`SELECT * FROM sends ORDER BY id DESC LIMIT ?`);

    // Claim runs in a transaction so two concurrent identical requests can't both
    // pass the de-dupe check and double-send.
    this._claimTxn = this.db.transaction((to, text, keyName, windowMs, now) => {
      const key = dedupeKey(to, text);
      const sent = this._lastSent.get(key, now - windowMs);
      if (sent) return { action: "duplicate_suppressed", row: sent };
      const inflight = this._inflight.get(key);
      if (inflight) return { action: "duplicate_inflight", row: inflight };
      const info = this._insert.run({ dedupe_key: key, to_number: to, text, key_name: keyName || null, now });
      return { action: "new", id: Number(info.lastInsertRowid) };
    });
  }

  // Decide what to do with an incoming send. Returns one of:
  //   { action:"new", id }                       -> caller should enqueue
  //   { action:"duplicate_suppressed", row }      -> identical sent within window
  //   { action:"duplicate_inflight", row }        -> identical already queued/active
  claim({ to, text, keyName, windowMs }) {
    return this._claimTxn(to, text, keyName, windowMs, Date.now());
  }

  attachJob(id, jobId) {
    this._attach.run(String(jobId), Date.now(), id);
  }

  markById(id, status, error = null) {
    this._setById.run(status, error, Date.now(), id);
  }

  markStatus(jobId, status, { attempts = 0, error = null } = {}) {
    if (!jobId) return;
    this._setStatusByJob.run({ job_id: String(jobId), status, attempts, error, now: Date.now() });
  }

  byJob(jobId) {
    return jobId ? this._byJob.get(String(jobId)) : null;
  }

  // Rows still unfinished — used on boot to rebuild the queue if Redis lost them.
  pending() {
    return this._pending.all();
  }

  stats() {
    const out = { queued: 0, active: 0, sent: 0, failed: 0, suppressed: 0 };
    for (const r of this._statsRows.all()) out[r.status] = r.n;
    return out;
  }

  recent(limit = 100) {
    return this._recent.all(Math.max(1, Math.min(limit, 1000)));
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

module.exports = { SendStore, dedupeKey };
