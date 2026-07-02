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

- **Device webhooks**: requests must include `?key=<API key>` (Shelly can't send headers). Unknown
  keys are rejected, and the comparison is constant-time.
- **Fails closed:** a fresh instance with **no** API key set **rejects all webhooks** (and
  `/api/history`) until you set one under `/admin`. `/admin` itself stays reachable via
  `ADMIN_PASSWORD`, so you can boot, open `/admin`, and set the key. To intentionally run an open,
  unauthenticated instance, tick **"Disable auth"** in `/admin` (sets `allowUnauthenticated=true`) —
  not recommended, since anyone who knows a registered `vid` could then trigger a valve close, push
  spam, or read history.
- The app stores the URL + username + API key per vehicle (`sh_webhook_url` / `sh_webhook_user` /
  `sh_webhook_key`).
- **Per-vehicle secret (SEC-4, for the hosted multi-tenant worker):** in addition to the instance
  `apiKey`, a vehicle may carry a `webhookSecret`; devices then send it as `&k=<secret>` and the worker
  verifies it per request (constant-time). This is **phased** — a vehicle with no secret is accepted as
  before, and while `WEBHOOK_AUTH_REQUIRED` is `false` (Phase 1) a set-but-unmatched secret is still
  processed and reported (`vehicleAuth: 'unauthenticated'`) so provisioned devices migrate without
  breaking; flip the flag to reject once they've all re-registered. See the main repo's
  `docs/SEC4_WEBHOOK_AUTH.md`.

## Storage backends

The `Storage` seam (`src/types.ts`) has four interchangeable implementations:

| backend | where | notes |
| --- | --- | --- |
| `MemoryStorage` | tests | in-process |
| `FileStorage` | self-host default | a JSON file, zero dependencies |
| `SqlStorage` + `NodeSqliteDriver` | self-host (durable) | `node:sqlite` (Node 22+, no native dep) — `createSqliteStorage('./data/brvg.db')` |
| `SqlStorage` + `D1Driver` | **hosted Cloudflare** | the same SQL on Cloudflare D1, used by the Worker adapter |

`SqlStorage` is one implementation over a tiny `SqlDriver` seam, so the schema + queries are written
and unit-tested once (against in-memory SQLite) and run on both SQLite and D1.

## Cloudflare Worker adapter (`src/worker.ts`)

The hosted counterpart to the Node server, **reusing the same injected core** (`handleShellyWebhook`)
and the LinkTap/FCM clients — only the transport (a `fetch` handler) and storage (D1) differ. Routes
mirror the Node server: `GET|POST /api/shelly`, `GET /api/history`, `GET /api/health`. This is the
path to **retiring the duplicated logic in the main repo's standalone `worker/`** (the cutover is an
owner step). Bindings + deploy notes are in `wrangler.toml`.

## Status

**Pre-1.0 (package `0.1.0`).** Core + events + Node adapter + file storage + admin + Docker + tests;
**tier-based history** (free 0 / basic 30d / premium ~3y, admin `retentionDays` cap) with
`GET /api/history`; **hourly downsampling** (raw 7 days, then one-per-hour); and **SQLite/D1 storage +
a Cloudflare Worker adapter sharing the core**. CI runs typecheck + tests + a Docker image build + a
`wrangler` dry-run that bundle-checks the Worker adapter. Remaining roadmap: unify with / retire the
main repo's hosted worker (owner-driven cutover). See the main repo's `docs/SELF_HOST.md` +
`open-tasks.md`.
