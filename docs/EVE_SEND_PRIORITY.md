# GMweb-API → Eve: Sending messages (normal vs. high priority)

How Eve should call the gateway so a **time-sensitive transactional message**
(e.g. a renewal confirmation) is sent **before** the rest of a running bulk
reminder campaign — without pausing the campaign.

## Why this exists

The gateway sends through **one** Google Messages browser, **one message at a
time** (~fast for an already-open chat, ~30–40s for a brand-new number). During
a campaign the queue can hold dozens of messages. A normal message goes to the
**back** of that queue. A **high-priority** message jumps to the **front**: it is
processed *next* (right after the message already in flight finishes), then the
campaign continues where it left off.

---

## Endpoint

```
POST {BASE}/send
Authorization: Bearer {API_KEY}
Content-Type: application/json
```

### Body

| field | type | required | meaning |
|---|---|---|---|
| `to` | string | yes | recipient with country code, e.g. `+989121234567` |
| `text` | string | yes | message body (plain text, ≤4000 chars) |
| `priority` | string | no | `"high"` = jump the queue, processed next. Omit or `"normal"` = FIFO (default). (A number 1–10 is also accepted; 1–3 count as high.) |
| `wait` | boolean | no | block until the send finishes (≤90s) and return the result. Use only for low volume. |

The call is **asynchronous by default**: it returns immediately with `202` and a
`jobId`. The actual send happens in the background.

## Tehran quiet hours

From **02:00 through 07:59 Asia/Tehran**, normal-priority messages remain in the
durable queue and are scheduled for 08:00. A fresh `"high"` first attempt may
bypass quiet hours. Once any job enters delayed/retry state it is held until
08:00 even if it remains HIGH. The installer also sets the Linux timezone to
`Asia/Tehran`.

---

## Normal send (bulk campaign — use this for reminders)

```bash
curl -X POST {BASE}/send \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+989121234567", "text": "حجم شما تمام شده، تمدید می‌کنید؟" }'
```

Response:
```jsonc
// 202 Accepted
{
  "ok": true,
  "jobId": "412",
  "status": "queued",
  "priority": "normal",
  "queuePosition": 37      // ~jobs ahead of it
}
```

## High-priority send (transactional — renewal confirmation, OTP, etc.)

Add `"priority": "high"`:

```bash
curl -X POST {BASE}/send \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+989121234567", "text": "تمدید شد ✅ 25GB / 31 روز", "priority": "high" }'
```

Response:
```jsonc
// 202 Accepted
{
  "ok": true,
  "jobId": "413",
  "status": "queued",
  "priority": "high",
  "queuePosition": 1       // ~next up (0–1 = only the in-flight send is ahead)
}
```

**Behavior:** the message already being sent finishes (it is not interrupted),
then job `413` is sent **next**, ahead of all waiting normal messages. After it,
the campaign continues. Multiple high-priority messages are all sent before any
normal ones, most-recent-first among themselves.

---

## Tracking the outcome

Either is fine; the gateway has no carrier delivery report, so terminal success
means "submitted to Google Messages" (see `EVE_DELIVERY_ANSWERS.md`).

**Poll:**
```
GET {BASE}/send/status/{jobId}
Authorization: Bearer {API_KEY}
```
```jsonc
{ "id": "413", "state": "completed", "to": "+98...", "attemptsMade": 1,
  "result": { "type": "sent", "fastPath": true, "at": "2026-06-25T10:36:21.229Z" },
  "failedReason": null }
```
- `state`: `waiting | active | completed | failed | delayed`. Map: `completed` → sent, `failed` → failed.
- `404` if the id is unknown/purged (success kept ~1 day, failures ~7 days).

**Or stream (push):** `GET {BASE}/events` (SSE) emits `send_queued`,
`send_processing`, `send_completed`, `send_failed`, each with `jobId`. The
`send_queued` event also includes `"priority": "high" | "normal"`.

---

## Recommended usage in Eve

- **Bulk reminder campaign** → send each with **no `priority`** (normal). They
  queue and drain in order.
- **Renewal confirmation / anything the customer is waiting on right now** →
  send with **`"priority": "high"`**. It cuts ahead of the campaign and goes
  next, so the customer who just paid gets their confirmation immediately even
  mid-campaign.

---

## Idempotency (avoid duplicate SMS on retry)

If a `POST /send` times out or the network blips, Eve may retry — which could
send the SMS twice. To prevent that, send an **`Idempotency-Key`** header: a
unique id Eve generates per logical message (e.g. a UUID, or
`renewal-<userId>-<timestamp>`).

```bash
curl -X POST {BASE}/send \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: renewal-8842-1782390000" \
  -d '{ "to": "+989121234567", "text": "تمدید شد ✅", "priority": "high" }'
```

Behavior:
- **First request** with a given key → enqueues normally, returns its `jobId`.
- **Retry with the same key + same `to`/`text`** → returns the **original
  `jobId`** with `"deduped": true`. No second SMS is queued.
- **Same key but different `to`/`text`** → `409 { "error": "idempotency_key_reused" }`
  (the key must identify one specific message).
- Keys are remembered for **24h**.

```jsonc
// retry response (deduped)
{ "ok": true, "jobId": "413", "status": "queued", "priority": "high", "deduped": true }
```

**Eve should generate one stable key per message and reuse it only when
retrying that exact message.** Optional but strongly recommended for renewals
and any send Eve might retry.

### Notes / limits

- **Throughput is bounded by one browser.** High priority changes *order*, not
  speed. If you fire many high-priority messages at once they still go one at a
  time; just before the normal ones.
- **Rate limit:** the `eve` key is currently unlimited. If a per-key limit is
  re-enabled later, a `429` carries a `Retry-After` header — wait that long.
- **Timestamps** are ISO-8601 UTC (`...Z`).
