<div align="center">

# 📲 GMweb API

**Control Google Messages for Web over a clean REST API.**
Send & read SMS/RCS from any app — with a queue, a self‑healing browser, and two dashboards.

</div>

---

GMweb keeps a persistent Chrome session signed into **[messages.google.com/web](https://messages.google.com/web)**
and puts a small, well‑documented HTTP API in front of it. Other projects (a CRM,
a billing system, a bot…) can then **send messages, read conversations, and react
to events** without touching the browser.

> ⚠️ This is **browser automation** over Google Messages for Web — not an official
> Google API. Treat the server like your phone: whoever controls it can read/send your SMS.

---

## ✨ What it does

- 📤 **Send SMS/RCS** over HTTP — queued, retried, and rate‑limited.
- 📥 **Read conversations & messages** — list chats, open threads, fetch history.
- 🚦 **Durable send queue** (BullMQ + Redis) — one message at a time, `high` priority can **jump the line**.
- 🧯 **Auto de‑dupe** — the same `{to, text}` sent twice within ~120s is suppressed (no double‑texting customers).
- 🔁 **Idempotency‑Key** support — safe retries from your side.
- 📡 **Real‑time events** — Server‑Sent Events (`/events`) or an outbound **webhook**.
- 🩺 **Self‑healing** — a watchdog + in‑app guard recover the browser when Google’s
  cookie‑rotation wedges the page (no more “stuck/spinning” sessions).
- 🖥️ **Two UIs** — a modern **React console** (`/app`) and the classic **dashboard** (`/dashboard`).
- 🔑 **Project API keys** (`gmw_…`) — give consumers messaging access without admin powers.
- 📜 **OpenAPI** — machine‑readable contract at `/docs` for easy integration.

---

## 🚀 One‑command install (Ubuntu 22.04)

The fastest path. A single **menu‑driven** script installs every dependency
(Chrome, Redis, VNC, Node), wires up **systemd services + a self‑healing watchdog
+ log rotation**, generates credentials, and **walks you through pairing** — then
lets you secure, monitor, update, or fully remove everything.

```bash
# from a cloned repo:
sudo bash install/quick-install.sh

# …or straight from GitHub (clones into /opt/gmweb-api):
curl -fsSL https://raw.githubusercontent.com/yoyoraya/GMweb-API/main/install/quick-install.sh | sudo bash
```

It installs a **`gmweb-install`** command to reopen the menu anytime:

```text
1) Quick install / repair     5) 🔒 Security (firewall · rotate token · audit)
2) 🔗 Pairing wizard          6) 🌐 Public dashboard (HTTPS)
3) ⚙️  Services (start/stop/VNC) 7) ⬆️  Update from git
4) 📊 Logs & monitoring        8) 🧨 Uninstall (full purge + self‑delete)
```

What the guided install sets up for you:

| Component | Purpose |
|---|---|
| `gmweb-chrome` | Google Chrome on a virtual display (Xvfb), exposed over CDP `:9222` |
| `gmweb-api` | the REST API on `127.0.0.1:3030` (requires Redis) |
| `gmweb-vnc` / `gmweb-novnc` | on‑demand VNC console for scanning the pairing QR |
| `gmweb-monitor.timer` | 🩺 watchdog every 2 min — heals a wedged session automatically |
| `/var/log/gmweb/` | install + watchdog logs, rotated weekly |

---

## 🔗 Pairing (first run)

Pairing links the server’s Chrome to Google Messages on your phone — exactly like
“Messages for web” on a laptop. The installer’s **Pairing wizard** does it step by step:

1. Turns the **VNC console** on.
2. Shows you the SSH‑tunnel + browser URL to view the server’s Chrome.
3. On your **phone**: Google Messages → ⋮ → **Device pairing** → **scan the QR**.
4. Polls `/ready` until **paired**, then turns VNC back off for safety.

---

## 🧪 Local development (Windows/macOS/Linux)

```bash
cp .env.example .env        # (Windows: copy .env.example .env)
npm install
npx playwright install chromium   # if Playwright must download a browser
npm start
```

Needs **Redis** running locally (BullMQ). Generate a strong token with `npm run token`.
First run requires pairing — use `npm run login` to sign into the profile, scan the QR,
then `npm start`.

The React console source lives in `dashboard-next/` (Vite + React + Tailwind):

```bash
cd dashboard-next && npm run dev      # hot‑reload UI, proxies the API on :3030
npm --prefix dashboard-next run build # outputs to public/dashboard-next (served at /app)
```

---

## 🔐 Auth model

| Token | Access |
|---|---|
| **Master token** (`API_TOKEN` env) | everything, incl. `/admin/*`, `/browser/*`, `/session/*` |
| **Project key** (`gmw_…`) | messaging + conversations only — admin paths return 401 |

Send it as `Authorization: Bearer <token>` on every request (except public `/health`).
Give external consumers a **project key** (create one in the dashboard or via `POST /admin/api-keys`).

---

## 📮 Sending a message

```bash
curl -X POST http://127.0.0.1:3030/send \
  -H "Authorization: Bearer gmw_..." \
  -H "Content-Type: application/json" \
  -d '{ "to": "+989121234567", "text": "Hello from GMweb!" }'
# -> 202 { "ok": true, "jobId": "123", "status": "queued" }
```

- ⚡ Jump the queue: add `"priority": "high"`.
- ⏳ Block for the result: add `"wait": true` (up to 90s).
- 🧯 Re‑sending the same `{to,text}` within ~120s returns `status:"duplicate_suppressed"` instead of texting twice.
- 🔁 Pass an `Idempotency-Key` header to make your own retries safe.

Track delivery via `GET /send/status/:jobId` or the live `GET /events` stream.

---

## 🧰 Core endpoints

| Method & path | What |
|---|---|
| `GET /health` | public health + version (used for contract‑sync detection) |
| `GET /ready` | 200 when paired & ready, 503 otherwise |
| `POST /send` · `GET /send/status/:id` | queue a message · poll a job |
| `GET /conversations?limit=` | list recent conversations |
| `GET /messages/active` · `POST /conversations/messages` | read the open / a specific thread |
| `GET /events` | SSE stream (`send_queued/processing/completed/failed`, `conversation_changed`) |
| `GET /admin/queue` · `GET /admin/queue/jobs` · `POST .../promote` · `DELETE .../:id` | queue stats, list, bump, cancel |
| `GET/POST/PATCH/DELETE /admin/api-keys…` | manage project keys |

📖 Full reference: **[docs/API.md](docs/API.md)** · machine‑readable **[docs/openapi.json](docs/openapi.json)** · live Swagger UI at **`/docs`**.
Integrating another project? See **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

---

## 🖥️ The two UIs

| URL | Notes |
|---|---|
| `…/app` | **React console** — overview, send, queue (promote/cancel), Google‑Messages‑style conversations, API keys, controls, VNC, logs |
| `…/dashboard` | **classic** built‑in dashboard (zero‑build) |

Both use the same 2‑step login (dashboard **password → API token**). On a VPS,
reach them via an SSH tunnel, or expose over HTTPS:

```bash
gmweb public-dashboard install dashboard.example.com admin@example.com
```

This sets up Nginx + Let’s Encrypt, proxies the local API, supports the noVNC
WebSocket, and switches dashboard cookies to `Secure`.

---

## 🩺 Reliability & self‑healing

Google periodically opens an `accounts.google.com/RotateCookiesPage` tab to rotate
session cookies. When that rotation stalls it **wedges** the Messages session —
the page spins, sends hang, the queue backs up. GMweb fights this on three levels:

1. 🧹 **Rotation guard** — closes the RotateCookiesPage tab every few seconds (in‑app).
2. ⏱️ **Lock watchdog** — no single browser action can hold the lock forever.
3. 🤖 **System watchdog** (`gmweb-monitor.timer`) — checks `/health` + `/ready` every
   2 min and restarts Chrome + API if the session stays unpaired.

Tunables (env): `SEND_DEDUPE_SECONDS`, `SEND_TIMEOUT_MS`, `SEND_FAIL_RESTART_THRESHOLD`, `POLL_INTERVAL_MS`.

---

## ⚙️ Manager command

```bash
gmweb            # interactive menu
gmweb status     gmweb restart        gmweb restart-chrome
gmweb vnc-on     gmweb vnc-off        gmweb token
gmweb smoke      gmweb uninstall
```

`gmweb-install` reopens the full installer menu (services, security, logs, update, uninstall).

---

## 🧨 Uninstall

From `gmweb-install → Uninstall`, choose either:

- **Remove GMweb** — services, app, user (keeps shared Chrome/VNC/Redis packages), or
- **Nuke everything** — also purges packages, logs, and deletes the installer itself.

A typed `DELETE GMWEB` confirmation is required.

---

## 🏗️ Architecture

| File | Role |
|---|---|
| [src/server.js](src/server.js) | Fastify app — routes, auth, OpenAPI, dedupe, SSE |
| [src/googleMessagesClient.js](src/googleMessagesClient.js) | Playwright automation + rotation guard + recovery |
| [src/queue.js](src/queue.js) | BullMQ send queue, idempotency, dedupe helpers |
| [src/apiKeys.js](src/apiKeys.js) | project keys (hashed), rate limits, IP allowlist |
| [public/dashboard/](public/dashboard/) · [dashboard-next/](dashboard-next/) | classic UI · React console |
| [install/quick-install.sh](install/quick-install.sh) · [scripts/gmweb-monitor.sh](scripts/gmweb-monitor.sh) | installer · watchdog |

More docs: [VPS](docs/VPS.md) · [No‑GUI VPS](docs/VPS_NO_GUI.md) · [Operations](docs/OPERATIONS.md) · [Simple setup](docs/SIMPLE_SETUP.md)

---

## 🛡️ Production notes

- ✅ `NODE_ENV=production` and a strong `API_TOKEN`.
- ✅ Keep the API bound to `127.0.0.1`; put HTTPS + a firewall in front.
- ✅ `ENABLE_DEBUG_ROUTES=false`.
- ✅ Keep `data/browser-profile` private and backed up (it holds the Google session).
- ✅ Give consumers a **project key**, not the master token.
