# GMweb API Operations

## Tehran timezone and quiet hours

Installers set the Linux server timezone to `Asia/Tehran`. The send worker also
uses that timezone explicitly: normal-priority SMS jobs are durably delayed from
02:00 through 07:59 and released at 08:00. Only fresh HIGH first attempts bypass
this rule; delayed/retrying jobs are held until 08:00 even when HIGH.
The defaults can be changed with `SEND_TIMEZONE`, `SEND_QUIET_START_HOUR`, and
`SEND_QUIET_END_HOUR`.

## Browser automation health and automatic recovery

`gmweb-monitor.timer` runs every two minutes. In addition to `/health` and
`/ready`, it launches `scripts/browser-probe.js`, which opens an independent
Playwright CDP connection and evaluates a tiny expression in the real Google
Messages page. This detects the otherwise invisible failure where VNC still
paints and `/ready` returns cached `paired:true`, but Chrome no longer accepts
automation commands. Two consecutive failed probes restart `gmweb-chrome` and
`gmweb-api`. A send-level browser/lock timeout triggers the same recovery
immediately, with a persistent five-minute cooldown.

The dashboard Overview card reports `automation_healthy` or `Hung`. The Queue
page reports queued/started timestamps, waiting and active durations, current
browser stage, time in that stage, attempts, SQLite tracking status, and a
plain-language diagnosis. Existing Redis backlog is imported into SQLite on
startup; all new sends, including sends using `Idempotency-Key`, are recorded
there from acceptance onward.

Overview also reports total CPU utilization/core count/load averages and
available/used RAM and swap. Conversation discovery is persisted in
`data/conversation-index.json`: restart uses that index immediately, while the
first run is capped by `CONVERSATION_INDEX_MAX_BATCHES` and
`CONVERSATION_INDEX_BUDGET_MS`. After first-run indexing, GMweb reloads the
conversation page to release the expanded sidebar DOM. Systemd CPU weights
favor `gmweb-api` over Chrome under contention so health and admin controls
remain responsive without throttling Chrome while spare CPU exists.

## Server Manager

On Ubuntu installs, run:

```bash
gmweb
```

The menu includes status, readiness, smoke test, restart, Chrome restart,
temporary VNC/noVNC access, logs, update, token display, and uninstall.

Non-interactive commands:

```bash
gmweb status
gmweb restart
gmweb restart-chrome
gmweb vnc-on
gmweb vnc-off
gmweb logs api
gmweb token
gmweb smoke
```

## Uninstall

Run:

```bash
gmweb uninstall
```

The uninstaller removes GMweb systemd services, `/usr/local/bin/gmweb*`
commands, `/opt/gmweb-api`, the browser profile, cached session data, and the
`gmweb` service user after you type `DELETE GMWEB`.

Chrome and VNC packages are only removed if you type `REMOVE PACKAGES`, because
they may be shared by other tools on the same VPS.

## Dashboard

Open:

```text
http://127.0.0.1:3030/dashboard
```

The dashboard uses the same `API_TOKEN`. It also sets an HttpOnly dashboard
cookie so the embedded noVNC iframe can access `/vnc`.

Production VPS installs create a limited sudoers file at
`/etc/sudoers.d/gmweb-api` so the `gmweb` service user can only start/stop VNC
and restart GMweb services from the dashboard.

## Public HTTPS Dashboard

Do not expose port `3030` directly to the internet. Keep:

```env
HOST=127.0.0.1
```

Then publish the dashboard through Nginx and Let's Encrypt:

```bash
gmweb public-dashboard install dashboard.example.com admin@example.com
```

Useful commands:

```bash
gmweb public-dashboard status
gmweb public-dashboard credentials
gmweb public-dashboard remove dashboard.example.com
```

After install, open:

```text
https://dashboard.example.com/dashboard
```

The public setup sets `DASHBOARD_COOKIE_SECURE=true` and
`CORS_ORIGIN=https://dashboard.example.com`. It also creates a dashboard
username/password login before the API token step.

## Rotate API Token

Generate a token:

```bash
npm run token
```

Put it in `.env`:

```env
API_TOKEN=<new-token>
```

Restart the process.

## Backup Browser Profile

Stop the server first, then back up:

```bash
tar -czf browser-profile-backup.tgz data/browser-profile
```

Restore by extracting it back to `data/browser-profile`.

## Readiness Check

Use:

```text
GET /ready
```

It returns HTTP `200` when paired and HTTP `503` when not ready.

## Speed

For production, keep:

```env
POLL_INTERVAL_MS=0
```

This disables background polling so send requests are not delayed by page reads.
Repeat sends are faster after the first successful send because recipient
conversation hrefs are cached in `data/conversation-cache.json`.

## Local Doctor

Run:

```bash
npm run doctor
```

To also check the running HTTP server:

```bash
DOCTOR_CHECK_SERVER=true npm run doctor
```

## Recovery

If Google Messages gets stuck:

```text
POST /browser/restart
```

If that does not recover, stop the process, run `npm run login`, repair Google Messages manually, close Chrome, and start the server again.

## Security

- Keep `.env` and `data/browser-profile` private.
- Do not enable `ENABLE_DEBUG_ROUTES` on public servers.
- Put the service behind HTTPS and a firewall.
- Prefer `HOST=127.0.0.1` behind Nginx.
