# GMweb API Operations

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
