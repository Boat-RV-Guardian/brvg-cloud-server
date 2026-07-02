# Deployment guide

How to run brvg-cloud-server for real: Docker Compose (the shipped path), bare Node, a Raspberry Pi
at home, or a VPS — plus HTTPS, backups, and upgrades. For what the endpoints do, see
[API.md](API.md); for the app side, see the website's
[self-hosting guide](https://boatrvguardian.com/docs/self-hosting).

One thing to get right before picking hardware: **your Shelly sensors must be able to reach this
server from the boat/RV's network.** See [Reachability](#reachability-sensors--server) below.

## Docker Compose (recommended)

Requirements: Docker with the Compose plugin. The image builds from `node:22-alpine`, runs as the
unprivileged `node` user, and stores its JSON database on a named volume.

```bash
git clone https://github.com/Boat-RV-Guardian/brvg-cloud-server.git
cd brvg-cloud-server
cp .env.example .env    # edit it — see below
docker compose up -d
```

### The `.env` file

| Variable | Required | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | **yes** | Basic-auth password for the admin console (username is ignored). Compose refuses to start without it |
| `FIREBASE_PROJECT_ID` `FIREBASE_CLIENT_EMAIL` `FIREBASE_PRIVATE_KEY` | no | Firebase service-account creds for FCM push. Omit all three to run without push — flood shutoff and state caching still work |
| `DB_PATH` | no | JSON database path. The compose file pins it to `/app/data/brvg.json` (on the volume) — leave it alone under Docker |
| `PORT` | no | Public API / webhook port, default `3030` |
| `ADMIN_PORT` | no | Admin-console port, default `3031` (a **separate** listener from `PORT`) |

> **Two ports.** The server runs the public API (`/healthz`, `/api/shelly`, `/api/history`) on
> `PORT` and the admin console (UI + `/admin/api/*`) on `ADMIN_PORT`. The shipped `docker-compose.yml`
> and `Dockerfile` publish **only `3030`**, so the admin UI (`3031`) is reachable on the container/host
> network but not from the internet by default — this is deliberate, so you can expose the webhook
> endpoint publicly while keeping admin private. To reach the admin UI, add `- "127.0.0.1:3031:3031"`
> to the compose `ports:` (host-only), tunnel it over SSH (`ssh -L 3031:localhost:3031 <host>`), or
> put it behind an authenticated reverse proxy. Prefer host-only / tunnel over publishing `3031` to
> the internet.

### Persistence

The compose file mounts the named volume `brvg-data` at `/app/data`; everything the server knows
(API key, vehicles, cached state, history, FCM tokens) lives in the single file
`/app/data/brvg.json`. `docker compose down` / `up` and image rebuilds keep it;
`docker compose down -v` deletes it. Writes are atomic (temp file + rename), so a crash mid-write
leaves the previous good file intact.

### Health check

The image ships a `HEALTHCHECK` that hits `http://127.0.0.1:3030/healthz` every 30 s. Check it:

```bash
curl http://localhost:3030/healthz          # → {"ok":true}
docker compose ps                           # STATUS should say "healthy"
```

### First-boot checklist

A fresh instance **rejects all webhooks** until it has an API key (fails closed):

1. Open the admin UI at `http://<server>:3031/` (any username, password = `ADMIN_PASSWORD`). Port
   `3031` isn't published by default — reach it over an SSH tunnel or a host-only port map (see the
   two-ports note above).
2. Set the instance **API key** — a long random string, e.g. `openssl rand -hex 24`.
3. Register your vehicle: `vid`, name, tier (`premium` or unset is sensible on a self-host —
   tier only throttles telemetry and caps history), allowed user IDs, and your **LinkTap cloud
   credentials** (username, API key, gateway ID, taplinker IDs) if you want cloud valve shutoff.
4. If you configured Firebase: map each user ID to their FCM token (Map user → FCM token).
5. In the app: Settings → Vehicles → Advanced → Custom Cloud Server URL — enter the server URL,
   a username, and the API key from step 2.

## Bare Node

Node **22+** is required (the code uses `node:sqlite` and the Docker image is `node:22-alpine`).

```bash
npm install
npm run build
ADMIN_PASSWORD=change-me DB_PATH=/var/lib/brvg/brvg.json node dist/server.js
```

For development, `ADMIN_PASSWORD=dev npm run dev` runs straight from TypeScript via tsx.

A minimal systemd unit:

```ini
[Unit]
Description=brvg-cloud-server
After=network-online.target

[Service]
User=brvg
WorkingDirectory=/opt/brvg-cloud-server
EnvironmentFile=/opt/brvg-cloud-server/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Raspberry Pi / home server

Works well — the server is a single small Node process with a JSON-file database, and storage is
hard-capped (5000 history samples per device, 64 devices per vehicle), so a Pi 3/4/5 or any old
mini-PC is plenty. `node:22-alpine` publishes arm64 images, so the Docker Compose path above works
unchanged on a 64-bit Pi OS.

The catch is reachability: sensors on the boat/RV fire webhooks **from the vehicle's network**, so
a server on your home LAN needs a route in from the outside — port forwarding + dynamic DNS, or a
VPN that the *vehicle's router* participates in. See the next section. Also put the Pi and its SD
card on a UPS if you can; the atomic-write storage survives power loss, but the hardware may not.

## VPS

The simplest reachable setup: any $3–6/month VPS with a public IP. Install Docker, run the Compose
path above, point a DNS name at it, and put Caddy or nginx in front for HTTPS. Resource needs are
tiny (well under 256 MB RAM). Since the server is on the public internet, keep the API key strong,
never enable "Disable auth", and use HTTPS so the key in webhook URLs isn't visible on the wire.

## Reachability (sensors → server)

Shelly sensors send webhooks from wherever the vehicle is parked or moored. Honest trade-offs:

| Option | Works when | Caveats |
| --- | --- | --- |
| **Public VPS** | Always — any network with internet | Server is public; you must do HTTPS + strong key. Simplest and most reliable |
| **Home server + port forward** | Vehicle has internet; your home ISP gives you a reachable IP | Needs router port-forward + dynamic DNS (or static IP); CGNAT breaks this |
| **Tailscale / WireGuard / VPN** | The **vehicle's router** joins the VPN | Individual Shelly sensors can't run a VPN client — this only works if the boat/RV's travel router routes the sensors' traffic into the VPN (e.g. a Tailscale subnet router). Nice and private, but more moving parts |

Whatever you pick, test from the vehicle's network:
`curl "https://your-server/api/shelly?vid=<vid>&key=<key>"` should answer (200/404), not time out.

## Reverse proxy + HTTPS

The server speaks plain HTTP. Because the API key travels in the query string, terminate TLS in
front of it for anything internet-facing. Caddy (automatic Let's Encrypt):

```
guardian.example.com {
    reverse_proxy 127.0.0.1:3030
}
```

nginx equivalent:

```nginx
server {
    listen 443 ssl;
    server_name guardian.example.com;
    # ssl_certificate / ssl_certificate_key via certbot or your CA
    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_set_header Host $host;
    }
}
```

Then use `https://guardian.example.com` as the Custom Cloud Server URL in the app. Shelly Gen2+
devices can call HTTPS URLs. If you proxy, you can also stop publishing port 3030
(`ports:` in `docker-compose.yml`) and let only the proxy reach it.

## Storage backends

| Backend | Where | What to know |
| --- | --- | --- |
| `FileStorage` (JSON file) | **Default** — what `server.ts` wires up | Zero dependencies; one file at `DB_PATH` (default `./data/brvg.json`); atomic writes; a corrupt file is preserved as `brvg.json.corrupt` instead of being overwritten |
| `SqlStorage` + `NodeSqliteDriver` | Self-host, durable | `node:sqlite` (Node 22+, no native dep). **Not wired by default**: `src/server.ts` hardcodes `FileStorage` — to use SQLite you currently edit the storage line to `await createSqliteStorage('./data/brvg.db')` (from `src/sql.ts`) and rebuild. There is no env switch yet |
| `SqlStorage` + `D1Driver` | Cloudflare Worker | Same SQL schema on Cloudflare D1 (below) |
| `MemoryStorage` | Tests only | In-process, nothing persists |

For a typical one-or-two-vehicle self-host, the JSON file default is fine — the hard caps keep it
small.

## Cloudflare Worker + D1

`src/worker.ts` runs the same core on Cloudflare Workers with D1 storage. `wrangler.toml` documents
the bindings:

```bash
npx wrangler d1 create brvg          # once — copy the database_id into wrangler.toml
npx wrangler secret put FIREBASE_PROJECT_ID    # + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (optional)
npx wrangler deploy
```

The Worker has **no `/admin` UI**, so configure it by writing rows into D1 directly. Hit
`/api/health` once after deploy (that lazily creates the schema), then:

```bash
npx wrangler d1 execute brvg --command \
  "INSERT INTO settings (key, value) VALUES ('apiKey','YOUR_KEY')
   ON CONFLICT(key) DO UPDATE SET value=excluded.value"
npx wrangler d1 execute brvg --command \
  "INSERT INTO vehicles (vid, json) VALUES ('boat1',
   '{\"vid\":\"boat1\",\"name\":\"Sea Breeze\",\"tier\":\"premium\",\"allowedUsers\":[]}')
   ON CONFLICT(vid) DO UPDATE SET json=excluded.json"
```

Note: deploying creates billable Cloudflare resources, and CI doesn't exercise the Worker bundle
yet — the Node server is the better-trodden path.

## Backups

Back up whichever store you use:

- **JSON file (default):** the single file `brvg.json`. Under Compose:
  `docker compose cp brvg-cloud-server:/app/data/brvg.json ./brvg-backup-$(date +%F).json`.
  Restore by copying it back and restarting. It contains your API key, LinkTap credentials, and
  FCM tokens — treat backups as secrets.
- **SQLite:** the `.db` file (stop the server first, or copy via `sqlite3 ".backup"`).
- **D1:** `npx wrangler d1 export brvg --output backup.sql`.

## Upgrades

Pre-1.0: check the README/release notes before upgrading. With Compose, data lives on the volume
and survives rebuilds:

```bash
git pull
docker compose build --pull
docker compose up -d
curl http://localhost:3030/healthz    # verify
```

Bare Node: `git pull && npm install && npm run build`, then restart the service.
