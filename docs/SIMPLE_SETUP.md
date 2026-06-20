# Simple Setup

This is the short path for a fresh Ubuntu 22 VPS.

## 1. Install

```bash
git clone https://github.com/yoyoraya/GMweb-API.git
cd GMweb-API
sudo bash install/ubuntu22.sh
```

The installer prepares:

- Chrome on a virtual display
- GMweb API service
- local-only API on port `3030`
- local-only noVNC helper for pairing
- a strong API token in `/opt/gmweb-api/.env`

## 2. Pair Google Messages

On the VPS:

```bash
gmweb vnc-on
```

On your own computer:

```bash
ssh -L 6080:127.0.0.1:6080 root@SERVER_IP
```

Open:

```text
http://127.0.0.1:6080/vnc.html
```

Sign in to Google Messages and scan the QR with your phone.

After pairing:

```bash
gmweb vnc-off
```

## 3. Test

On the VPS:

```bash
gmweb status
gmweb smoke
gmweb token
```

You can also type `gmweb` to open the full server menu.

## 4. Use API From Your Computer

Open an SSH tunnel:

```bash
ssh -L 3030:127.0.0.1:3030 root@SERVER_IP
```

Then call:

```bash
curl -H "Authorization: Bearer TOKEN" http://127.0.0.1:3030/ready
```

## Speed Notes

`POLL_INTERVAL_MS=0` is the default production setting. This prevents background
polling from interrupting sends. Conversation hrefs are cached in
`data/conversation-cache.json`, so repeat sends to the same recipient are faster.
