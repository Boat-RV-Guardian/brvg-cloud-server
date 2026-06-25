# brvg-cloud-server

Self-hostable cloud server for **Boat & RV Guardian** — the open-source, Dockerized counterpart to the
hosted Cloudflare worker. Run your own and the app's away-from-home features (flood auto-shutoff,
push alerts, remote state) work with no dependency on our cloud.

Point the app at it under **Settings → Vehicles → Advanced Vehicle Settings → Custom Cloud Server URL**
(set the URL + the username/API key you create here).

## What it does

- Receives Shelly device webhooks at **`/api/shelly`** (GET or POST — Shelly fires GET).
- On a real flood/leak alarm, closes every configured LinkTap valve via the LinkTap cloud API.
- Caches each device's last-known state so the app can show it off-LAN (tier-aware throttling).
- Sends FCM push alerts to the vehicle's users (optional — needs Firebase creds).
- **`/admin`** (basic-auth) to set the instance API key, data-retention window, register vehicles
  (with LinkTap creds), and map users to FCM tokens.

The safety-critical decision logic lives in [`src/core.ts`](src/core.ts) + [`src/events.ts`](src/events.ts)
and is fully unit-tested with injected deps ([`src/core.test.ts`](src/core.test.ts)) — no hardware needed.

## Architecture

Transport-agnostic **core** (`core.ts`) with injected **deps** (`Storage`, `Notifier`, `LinkTapClient`),
so the same logic can run on Node (today) or a Cloudflare adapter later. Storage is pluggable:
`MemoryStorage` (tests) and `FileStorage` (JSON file; the zero-dependency self-host default). A
SQLite/D1 storage can be added behind the same interface.

## Run

### Docker (recommended)
```bash
cp .env.example .env   # set ADMIN_PASSWORD (and Firebase creds if you want push)
docker compose up -d
# admin: http://localhost:3030/admin   webhooks: http://localhost:3030/api/shelly
```

### Local (Node 22+)
```bash
npm install
ADMIN_PASSWORD=dev npm run dev    # tsx, no build step
npm test                          # vitest
npm run build && npm start        # compiled
```

## Auth contract (matches the app)

- **Device webhooks**: if an instance API key is set, requests must include `?key=<API key>` (Shelly
  can't send headers). Unknown keys are rejected.
- The app stores the URL + username + API key per vehicle (`sh_webhook_url` / `sh_webhook_user` /
  `sh_webhook_key`).

## Status

**v0.2.** Core + events + Node adapter + file storage + admin + Docker + tests, plus **tier-based
history** (telemetry samples retained per tier — free 0 / basic 30d / premium ~3y — with the admin
`retentionDays` setting as a self-host cap) and a `GET /api/history?vid=&device=&since=` read endpoint.
Roadmap: SQLite/D1 storage, hourly downsampling for long-term history, a Cloudflare adapter sharing
this core, and unifying with the hosted worker. See the main repo's `docs/SELF_HOST.md` + `open-tasks.md`.
