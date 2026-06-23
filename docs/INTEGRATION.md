# GMweb — Integration Guide (for a consuming project)

This document is the stable hand-off for **another project** that wants to send and
read messages through this GMweb server. Hand this file plus
[`openapi.json`](./openapi.json) to the other project (or its AI agent) and it has
everything needed to integrate — without reading any of GMweb's internal source.

- **Machine-readable contract:** [`openapi.json`](./openapi.json) — full request/response
  schemas, generated from the live code so it always matches reality.
- **Human + agent guide:** this file — auth, the endpoints that matter, and the
  **sync mechanism** so the consumer stays up to date when GMweb is updated.

---

## 1. Connecting

| | |
|---|---|
| **Base URL** | `https://YOUR_HOST` (set to your deployed host; locally it is `http://127.0.0.1:3030`) |
| **Auth** | `Authorization: Bearer <token>` on every request except `GET /health` |
| **Token type** | Use a **Project API key** (`gmw_...`), *not* the master token |

### Getting a Project API key
A project key can call messaging + conversation endpoints but **cannot** touch admin
routes (`/admin/*`, `/browser/*`, `/session/*`) — those return 401. This is the safe
credential to give the consuming project.

Create one from the GMweb dashboard, or with the master token:

```bash
curl -X POST https://YOUR_HOST/admin/api-keys \
  -H "Authorization: Bearer <MASTER_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "project-two",
        "allowedIps": ["<PROJECT_TWO_SERVER_IP>"],
        "rateLimit": { "minute": 10, "hour": 100 }
      }'
```

The full `gmw_...` token is returned **only once** in that response — store it in the
consuming project's secrets (env var), never in code.

> Because the consumer connects over the internet, set `allowedIps` to its server IP
> and serve GMweb over **HTTPS** (terminate TLS at a reverse proxy). Repeated bad-auth
> attempts from an IP are auto-blocked for 30 minutes.

---

## 2. The endpoints that matter to a consumer

Full schemas are in [`openapi.json`](./openapi.json). The relevant subset:

| Method & path | Purpose |
|---|---|
| `GET /health` | Public. Returns `{ ok, service, version }`. Used for **sync detection** (see §4). |
| `GET /ready` | `200` when Google Messages is paired and ready; `503` otherwise. Check before sending. |
| `POST /send` | Queue a message. Returns `202 { jobId }`. Pass `"wait": true` to block for the result. |
| `GET /send/status/:jobId` | Poll a send job: `waiting` / `active` / `completed` / `failed` / `delayed`. |
| `GET /conversations?limit=20` | List recent conversations (title, snippet, unread, stable `href`). |
| `POST /conversations/open` | Open a conversation by `href` / `id` / `title` / `index`. |
| `GET /messages/active?limit=50` | Read messages from the currently open conversation. |
| `POST /conversations/messages` | Open a conversation **and** return its messages in one call. |
| `GET /events` | SSE stream: `send_queued` / `send_processing` / `send_completed` / `send_failed` / `conversation_changed`. |

### Send a message
```bash
curl -X POST https://YOUR_HOST/send \
  -H "Authorization: Bearer gmw_..." \
  -H "Content-Type: application/json" \
  -d '{ "to": "+989121234567", "text": "Hello" }'
# -> 202 { "ok": true, "jobId": "...", "status": "queued" }
```
Phone numbers must include the country code. Sends are async by default; either poll
`GET /send/status/:jobId` or listen on `GET /events`. For simple callers, add
`"wait": true` to get `200 { status: "completed" }` directly (up to 90s).

### Read incoming SMS
```bash
# 1) list conversations, grab a href
curl -H "Authorization: Bearer gmw_..." "https://YOUR_HOST/conversations?limit=20"
# 2) read one conversation
curl -X POST https://YOUR_HOST/conversations/messages \
  -H "Authorization: Bearer gmw_..." -H "Content-Type: application/json" \
  -d '{ "href": "/web/conversations/123", "limit": 50 }'
```

---

## 3. Source of truth & versioning

`openapi.json` is **generated from the route schemas** in GMweb's code, so it never
drifts from the real behavior. Its `info.version` mirrors `package.json` `version`,
and `GET /health` returns that same `version`. That single number is the sync signal.

When GMweb changes:
1. Maintainer bumps `version` in `package.json`.
2. Maintainer runs `npm run export:openapi` → refreshes the committed `openapi.json`.
3. Consumers notice the new `version` from `/health` and re-fetch the spec (see §4).

---

## 4. Hybrid sync (static file + auto re-fetch)

The consuming project keeps a **local committed copy** of `openapi.json`, and at runtime
**checks `/health`** to detect a new version and pull a fresh spec automatically. Best of
both: works offline from the committed file, self-heals when GMweb is updated.

Drop this into the consuming project:

```js
// gmweb-sync.js — keep the local OpenAPI spec in sync with the GMweb server.
import fs from "node:fs/promises";

const BASE = process.env.GMWEB_BASE_URL;     // e.g. https://your-host
const TOKEN = process.env.GMWEB_API_KEY;     // gmw_... project key
const SPEC_PATH = new URL("./gmweb.openapi.json", import.meta.url);

async function localVersion() {
  try {
    const spec = JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));
    return spec?.info?.version ?? null;
  } catch {
    return null;            // no local copy yet
  }
}

// Returns the spec, re-fetching only when the server's version differs.
export async function ensureSpec() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  const remote = health.version;
  const local = await localVersion();

  if (local === remote) {
    return JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));   // up to date
  }

  // Version changed (or first run) -> pull the fresh contract.
  const res = await fetch(`${BASE}/docs/json`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`);
  const spec = await res.json();
  await fs.writeFile(SPEC_PATH, JSON.stringify(spec, null, 2));
  console.log(`GMweb spec synced: ${local ?? "none"} -> ${remote}`);
  return spec;
}
```

Call `ensureSpec()` on startup (and optionally on an interval). `/health` is public and
cheap, so the version check costs almost nothing; the full `/docs/json` fetch (which
needs the project key) happens **only** when the version actually changed.

> Note: a `version` bump signals "something changed." Whether it's a breaking change is
> up to GMweb's versioning discipline — treat a **major** bump as potentially breaking and
> review the diff of `openapi.json` before relying on new behavior.
