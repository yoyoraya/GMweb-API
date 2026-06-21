# GMweb API On Ubuntu 22 VPS Without GUI

The VPS does not need a real desktop. Use a virtual display with `Xvfb`, view it
temporarily through VNC over an SSH tunnel, sign in once, pair Google Messages,
then run the bridge against that same Chrome profile.

If you installed with `install/ubuntu22.sh`, use `gmweb` for the whole flow:

```bash
gmweb
gmweb vnc-on
gmweb vnc-off
gmweb status
gmweb restart
```

The same install also serves the dashboard at `/dashboard`. The dashboard can
turn noVNC on and embed it through `/vnc`, so one tunnel to port `3030` is enough
for normal management:

```bash
ssh -L 3030:127.0.0.1:3030 root@YOUR_SERVER_IP
```

For public access without SSH, point a domain to the VPS and run:

```bash
gmweb public-dashboard install dashboard.example.com admin@example.com
```

This publishes `/dashboard` and `/vnc` through HTTPS while keeping Chrome CDP,
VNC, noVNC, and the Node API bound to localhost.

## Why Not Cookies Only?

Google Messages state is more than cookies: cookies, LocalStorage, IndexedDB,
service workers, Google account state, pairing state, and browser-profile data
all matter. Copying only cookies is fragile. Copying a Windows Chrome profile to
Linux is also unreliable because cookie storage is OS-specific.

## Install Packages

```bash
sudo apt update
sudo apt install -y curl wget gnupg xvfb x11vnc fluxbox novnc websockify

wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
  | sudo gpg --dearmor -o /usr/share/keyrings/google-linux.gpg

echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list

sudo apt update
sudo apt install -y google-chrome-stable
```

## Start Virtual Chrome

From the project directory:

```bash
chmod +x scripts/vps-chrome.sh
ROOT_DIR="$PWD" USER_DATA_DIR="$PWD/data/browser-profile" scripts/vps-chrome.sh
```

In another SSH session, expose the virtual display with VNC bound to localhost:

```bash
DISPLAY=:99 x11vnc -localhost -forever -shared -rfbport 5900
```

Optional browser-based noVNC:

```bash
websockify --web=/usr/share/novnc/ 127.0.0.1:6080 127.0.0.1:5900
```

From your local machine:

```bash
ssh -L 6080:127.0.0.1:6080 root@YOUR_SERVER_IP
```

Open:

```text
http://127.0.0.1:6080/vnc.html
```

Sign in to Google, open Google Messages, scan the QR from your phone, and verify
that conversations load.

## Run Bridge In Connect Mode

Set `.env`:

```env
NODE_ENV=production
HEADLESS=false
USER_DATA_DIR=./data/browser-profile
BROWSER_MODE=connect
BROWSER_CDP_URL=http://127.0.0.1:9222
API_TOKEN=<long-random-token>
ENABLE_DEBUG_ROUTES=false
```

Keep `scripts/vps-chrome.sh` running as the Chrome process. Then start the API:

```bash
npm start
```

Check:

```bash
npm run smoke
```

## Production Shape

Run two processes:

- Chrome on `Xvfb :99` with remote debugging on `127.0.0.1:9222`
- Node bridge in `BROWSER_MODE=connect`

Both can be managed by PM2 or systemd. Do not expose VNC or CDP publicly.
