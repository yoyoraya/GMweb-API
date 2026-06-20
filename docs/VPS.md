# GMweb API VPS Setup

## 1. Install

```bash
git clone <your-repo-url> gmweb-api
cd gmweb-api
npm install
cp .env.example .env
```

Install Chrome if it is not already installed.

## 2. Configure .env

```env
NODE_ENV=production
PORT=3030
HOST=127.0.0.1
API_TOKEN=use-a-long-random-token
HEADLESS=true
USER_DATA_DIR=./data/browser-profile
```

Use `HOST=127.0.0.1` behind Nginx. Use `HOST=0.0.0.0` only if firewall rules are tight.

## 3. Pair Google Messages

Start once:

```bash
npm start
```

Open:

```text
GET /session/screenshot
```

Scan the QR with Google Messages on your phone. The session is stored in `data/browser-profile`.

## 4. Run with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Notes

- Keep `data/browser-profile` private and backed up. It contains the paired browser state.
- Do not expose this API publicly without HTTPS, firewall rules, and a strong `API_TOKEN`.
- `ENABLE_DEBUG_ROUTES=false` should stay false in production.
- For a VPS without a real GUI, use [VPS_NO_GUI.md](VPS_NO_GUI.md).
