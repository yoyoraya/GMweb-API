# GMweb API

OpenWA-style HTTP bridge for Google Messages for Web. It keeps a persistent
Chrome profile, exposes a small HTTP API, can send messages, lists
conversations, and emits basic change events through SSE or an optional webhook.

This is browser automation over `https://messages.google.com/web`, not an
official Google Messages API.

## Quick Start

```powershell
copy .env.example .env
npm.cmd install
npm.cmd start
```

PowerShell may block `npm.ps1`; use `npm.cmd` on Windows.

If Playwright cannot download Chromium, use the installed Chrome:

```env
CHROME_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

The app auto-detects common Chrome paths on Windows, Linux, and macOS.

Generate a strong token:

```powershell
npm.cmd run token
```

## First Login And Pairing

If Google shows `This browser or app may not be secure`, sign in with normal
Chrome using the same project profile:

```powershell
npm.cmd run login
```

Sign in, open Google Messages, pair the phone, then close that Chrome window.
After that, start the API server:

```powershell
npm.cmd start
```

Check readiness:

```powershell
curl.exe -H "Authorization: Bearer change-me" http://localhost:3030/session/status
```

Run a no-send smoke test:

```powershell
npm.cmd run smoke
```

Run local environment checks:

```powershell
npm.cmd run doctor
```

## Send

PowerShell-friendly JSON:

```powershell
$body = @{ to = '+989121234567'; text = 'test from API' } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri 'http://localhost:3030/send' `
  -Method Post `
  -Headers @{ Authorization = 'Bearer change-me' } `
  -ContentType 'application/json; charset=utf-8' `
  -Body $body
```

## Events

SSE:

```powershell
curl.exe -N -H "Authorization: Bearer change-me" http://localhost:3030/events
```

Webhook:

```env
WEBHOOK_URL=https://example.com/google-messages-webhook
```

## Endpoints

- `GET /health`
- `POST /browser/start`
- `POST /browser/stop`
- `GET /session/status`
- `GET /session/screenshot`
- `GET /conversations?limit=20`
- `GET /messages/active?limit=50`
- `POST /send`
- `GET /events`

Detailed API docs: [docs/API.md](docs/API.md)

VPS notes: [docs/VPS.md](docs/VPS.md)

No-GUI Ubuntu VPS notes: [docs/VPS_NO_GUI.md](docs/VPS_NO_GUI.md)

Operations notes: [docs/OPERATIONS.md](docs/OPERATIONS.md)

Simple setup path: [docs/SIMPLE_SETUP.md](docs/SIMPLE_SETUP.md)

## VPS Manager

The Ubuntu installer adds a server-side manager command:

```bash
gmweb
```

Useful shortcuts:

```bash
gmweb status
gmweb restart
gmweb restart-chrome
gmweb vnc-on
gmweb vnc-off
gmweb token
gmweb smoke
gmweb uninstall
```

`gmweb uninstall` removes services, command wrappers, app files, browser
profile data, and the service user after a typed confirmation.

## Dashboard

The API serves a built-in dashboard:

```text
http://127.0.0.1:3030/dashboard
```

Use the same `API_TOKEN` to unlock it. The dashboard can show readiness,
systemd service state, conversations, send messages, restart the browser/API,
turn noVNC on and off, and embed the noVNC console through `/vnc`.

On a VPS, open it from your computer with one SSH tunnel:

```bash
ssh -L 3030:127.0.0.1:3030 root@SERVER_IP
```

To expose the dashboard publicly, keep the API bound to `127.0.0.1` and put
Nginx with HTTPS in front:

```bash
gmweb public-dashboard install dashboard.example.com admin@example.com
```

This installs Nginx/Certbot, proxies HTTPS traffic to the local API, supports
the embedded noVNC WebSocket path, switches dashboard cookies to `Secure`, and
creates a dashboard username/password before the API token step.

## Production Notes

- Set `NODE_ENV=production`.
- Set a strong `API_TOKEN`.
- Keep `ENABLE_DEBUG_ROUTES=false`.
- Keep `data/browser-profile` private and backed up.
- Run behind HTTPS and a firewall when exposed outside localhost.
