# Netwatch

Logs your home internet's speed and outages from an always-on device (runs on Pocket).

- Speed test every hour (configurable) against Cloudflare's public speed endpoints: download, upload, ping, jitter.
- Connectivity check every 20 s. Outages are logged with their length and whether the router still answered
  (router or Wi-Fi problem vs. provider outage).
- Alerts through Pocket when the internet comes back, and when 3 tests in a row are under half your plan speed.
- Dashboard with 24 h / 7 d / 30 d charts, uptime and an outage list.

No dependencies. Data is kept in `data/` (persisted across Pocket deploys).

```bash
PORT=3000 node server.js
```

Environment (all optional): `GATEWAY` (router address, default `192.168.0.1`), `PROBES`
(`host:port,...` to test connectivity), `CHECK_EVERY_MS`.

## Deploying

Pushes to `main` deploy to the Pocket phone server automatically (it checks every 2 minutes), with a health check and automatic rollback if the new version fails to start.
