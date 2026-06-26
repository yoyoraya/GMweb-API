# GMweb-API → Eve: Delivery-Confirmation Answers

> Reply to `SMS_GATEWAY_DELIVERY_SPEC.md`. Answers below reflect the **actual current
> code** of GMweb-API, plus what we can realistically add. Hand this back to Eve's Claude.

## 0) Most important architectural fact (read first)

GMweb-API is **not** a SIM/modem gateway. It drives **Google Messages for Web** through a
headless-ish Chrome via Playwright, riding a **paired Android phone**. Consequences:

- There is **no carrier DLR (delivery report)** available to us programmatically. We do not
  talk to an SMSC.
- What we confirm today is: *"the message was typed into the Google Messages composer for
  this recipient and the Send action was triggered, and an outgoing bubble was produced."*
  That is closer to your **`sent`** ("left the device") than to **`delivered`**.
- Google Messages **does** render per-bubble status in the DOM ("Sent" / "Delivered" /
  "Read", and "Not delivered" on failure — strongest for RCS, weaker/again for plain SMS).
  So scraping a real `delivered`/`failed` is *technically possible to add*, but it is **not
  implemented yet**. See §1.

So: **today the best terminal success state we can honestly offer is `sent`.** We can add
DOM-scraped `delivered`/`failed` as a follow-up (effort note at the end).

---

## Answers to §6 checklist

### 1. Delivery reports (DLR)
- **Carrier DLR:** No. We have none.
- **What we can guarantee today:** `sent` only — meaning "submitted to Google Messages and
  an outgoing bubble appeared." We do **not** currently read the bubble's delivery indicator.
- **`delivered`:** Not guaranteed today. It is *possible* to add by polling the Google
  Messages DOM for the message status label after send, but it's unimplemented and somewhat
  fragile (depends on Google's UI, RCS vs SMS, and the conversation staying open). Treat
  `sent` as the terminal success state for now.

### 2. `/send` id — exact current response
Endpoint already returns a stable id, but the field is named **`jobId`**, not `id`, and the
body shape differs from your §4.0. **Real current body:**

```jsonc
// HTTP 202 Accepted
{
  "ok": true,
  "jobId": "42",              // <-- this is the stable id; use it as your `id`
  "status": "queued",         // always "queued" on accept
  "queuePosition": 3          // approx jobs ahead (waiting + active)
}
```
- The `jobId` is a BullMQ job id (string). It is stable and unique, and is what
  `/send/status/{jobId}` and the SSE/webhook events key on.
- `to` and `accepted_at` are **not** in the body today. Easy to add if you need them.
- **429 (rate limited)** body:
  ```jsonc
  { "error": "send_rate_limited", "reason": "per_minute_limit",
    "limits": { "minute": 10, "hour": 100 }, "used": { "minute": 10, "hour": 5 } }
  ```
  with header `Retry-After: 60`.

**Recommendation for Eve:** store `jobId` as your message id. If you want the literal field
name `id`, we can add an `id` alias (= `jobId`) in one line — tell us and we'll add it.

### 3. Webhook
- **Can we POST callbacks?** Yes, partially — but **not in your §4.2 shape, and not signed,
  and not retried** today. Current behavior:
  - There is a single global `WEBHOOK_URL` env var. When set, the worker POSTs the **send
    lifecycle events** to it.
  - **No HMAC signature.** No `X-GMweb-Signature` header.
  - **No retry/backoff.** Fire-and-forget; failures are only logged.
  - **No per-API-key callback URL** — it's one global URL for the whole gateway.
- **Real current payloads** (this is what actually goes out):
  ```jsonc
  // success
  { "type": "send_completed", "jobId": "42", "to": "+989121234567",
    "text": "...", "fastPath": true, "at": "2026-06-25T09:10:42.000Z" }

  // failure (may fire multiple times across retries; willRetry tells you if more coming)
  { "type": "send_failed", "jobId": "42", "to": "+989121234567",
    "error": "Could not open a conversation for +989121234567.",
    "attemptsMade": 3, "willRetry": false, "at": "2026-06-25T09:10:42.000Z" }
  ```
  Note: `send_completed` here means "submitted to Google Messages" (your `sent`), **not**
  handset `delivered`.
- **To match your §4.2 contract** we would add: a `status` field using your enum, HMAC-SHA256
  signing via `X-GMweb-Signature`, retry-with-backoff, idempotency, and per-key callback +
  secret config. That is a real change — see "What we can add" below.

### 4. Polling — exact current response
Endpoint exists: `GET /send/status/{jobId}` (Bearer auth). **Real current body:**

```jsonc
// 200 OK
{
  "id": "42",
  "state": "completed",          // waiting | active | completed | failed | delayed
  "to": "+989121234567",
  "attemptsMade": 1,
  "maxAttempts": 3,
  "result": { "type": "sent", "to": "...", "text": "...", "fastPath": true,
              "at": "2026-06-25T09:10:42.000Z" },
  "failedReason": null,          // free-text error string when state=failed
  "createdAt": "2026-06-25T09:10:17.000Z",
  "processedAt": "2026-06-25T09:10:40.000Z",
  "finishedAt": "2026-06-25T09:10:42.000Z"
}
```
- **404** `{ "error": "not_found" }` if the job id is unknown or already purged (see §8).
- **Field name is `state`, not `status`,** and the values are **BullMQ queue states**, not
  your §4.1 enum. Mapping you can apply on Eve's side right now:

  | our `state` | your status |
  |---|---|
  | `waiting`, `delayed` | `queued` |
  | `active` | `sending` |
  | `completed` | `sent` (success; **not** confirmed delivered) |
  | `failed` | `failed` |

- **Batch `POST /status`:** not implemented. Can add if you want it.

### 5. Error codes
We do **not** emit machine codes today. `failedReason` / webhook `error` is a free-text
string from the thrown exception. The realistic set of strings today:
- `"Google Messages is not ready: <hint>"` — not paired / QR / sign-in needed → maps to your
  `sim_not_ready`.
- `"Could not open a conversation for <to>."` → maps to `invalid_number` / `carrier_rejected`
  (we can't currently distinguish).
- `"Both 'to' and 'text' are required."` → bad request (won't reach the queue normally).
- Playwright/timeout errors (`"Timeout ... exceeded"`, navigation errors) → maps to
  `unknown_error` / `no_signal`.

We can add a `error_code` field with your stable enum (`no_credit`, `invalid_number`,
`blocked_number`, `carrier_rejected`, `no_signal`, `sim_not_ready`, `rate_limited`,
`expired`, `unknown_error`) by classifying these messages. Note: because we lack carrier
feedback, several of these (`no_credit`, `blocked_number`) we **cannot** detect — we'd only
ever return the subset we can actually observe.

### 6. Rate limits
- Per **project API key**: default **10/minute and 100/hour** (configurable per key).
- The master token is **not** rate-limited.
- There's also internal pacing: a single worker, **concurrency 1**, one browser, one send at
  a time — so effective throughput is one message at a time regardless of the limit.
- **`Retry-After` on 429:** Yes — we send `Retry-After: 60` (fixed 60s) plus a JSON body with
  `limits`/`used`. We can make it reflect the exact remaining window if you need precision.

### 7. Idempotency
- **None today.** If Eve retries `/send` after a network blip, we **will enqueue a duplicate**
  and send the SMS twice. No `Idempotency-Key` support yet.
- We can add `Idempotency-Key` (header) → dedupe within a TTL window using Redis. Tell us the
  header name you prefer; `Idempotency-Key` is fine.

### 8. ID lifetime (how long `/send/status/{jobId}` works)
Driven by BullMQ retention:
- **Successful** jobs: kept **~1 day** (86400s) or last **1000** jobs, whichever first.
- **Failed** jobs: kept **~7 days** (604800s) or last **1000**.
After that, `/status/{jobId}` returns **404**. Poll/finalize within those windows.

### 9. Timestamps & timezone
All timestamps are **ISO-8601 UTC with `Z`** (`new Date().toISOString()`), e.g.
`2026-06-25T09:10:42.000Z`. Safe to convert to Asia/Tehran for display.

---

## Net: what works for Eve **right now** vs. what needs building

**Works today (Eve can wire this immediately):**
- Store `jobId` from the `/send` 202 body as the message id.
- Poll `GET /send/status/{jobId}` and map `state` → your enum (table in §4). Terminal success
  = `completed` → show as **`sent`** (honestly "submitted", not "delivered").
- Or subscribe to `GET /events` (SSE) for `send_completed` / `send_failed` push.
- Honor `Retry-After: 60` on 429.

**Needs building on the gateway (pick from "minimum" / "best"):**
1. **(small)** Add `id` alias + `to` + `accepted_at` to the `/send` body to match §4.0 exactly.
2. **(small)** Add a `status` field (your §4.1 enum) and `error_code` (your §4.4 enum, subset)
   to `/send/status` and the webhook, so Eve doesn't have to map.
3. **(medium)** Signed webhook to match §4.2: per-key callback URL + shared secret, HMAC-SHA256
   `X-GMweb-Signature`, retry-with-backoff, idempotent.
4. **(medium)** `Idempotency-Key` support (§6.7).
5. **(larger / fragile)** Real `delivered`/`failed` by scraping the Google Messages bubble
   status from the DOM after send. This is the only way to move beyond `sent`, and it depends
   on Google's UI + RCS availability. Recommend treating as best-effort `delivered` with
   fallback to `unknown`.

**Honest bottom line for Eve:** with zero gateway changes you can already show **sent /
failed** (instead of just "accepted") via polling or SSE. Showing a true **delivered** requires
item 5 and is best-effort, because this gateway has no carrier-level delivery report.
