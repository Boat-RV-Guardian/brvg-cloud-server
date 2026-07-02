# HTTP API reference

Every endpoint of the Node server (`src/server.ts`), verified against the source. The Cloudflare
Worker adapter (`src/worker.ts`) exposes the same public API minus the admin surface — differences
are noted at the end.

### Two servers, two ports

`src/server.ts` starts **two** HTTP listeners:

| Server | Default port (env) | Serves |
| --- | --- | --- |
| **Public API** | `3030` (`PORT`) | `/healthz`, `/api/shelly`, `/api/history` — the surface Shelly devices and the app hit |
| **Admin UI** | `3031` (`ADMIN_PORT`) | the admin console (static UI at `/`) and `/admin/api/*` |

Keeping admin on its own port means you can publish only the public API port to the internet and
keep the admin console on your host / private network. The default Docker setup publishes **only
`3030`** — see [DEPLOYMENT.md](DEPLOYMENT.md) for reaching the admin UI.

All responses are JSON except the admin UI's static HTML. Unknown paths on the public server return
`404 {"error":"not found"}`; unexpected failures return `500 {"error":"<message>"}`.

## Auth model

Two independent schemes:

| Surface | Scheme | Where |
| --- | --- | --- |
| `/api/shelly`, `/api/history` | Instance **API key** as `?key=` query param | Shelly devices can't send headers, so the key rides in the URL |
| Admin UI + `/admin/api/*` (admin port) | **HTTP Basic auth** against `ADMIN_PASSWORD` | Username is ignored; only the password is checked |

`/api/shelly` also accepts a per-vehicle secret `?k=` in addition to the instance `key`. On a
self-hosted instance the instance `key` is the one you configure; `k` is used by the hosted service's
per-vehicle auth and is optional here.

The API key is set in the admin UI (or `POST /admin/api/settings`). **Fails closed**: with no key
configured, `/api/shelly` and `/api/history` reject everything (401) until you set one — unless you
explicitly tick "Disable auth" (`allowUnauthenticated=true`), which is not recommended. Both key and
password comparisons are constant-time.

Because the key is in the query string, serve the API over HTTPS in production (see
[DEPLOYMENT.md](DEPLOYMENT.md)) and treat webhook URLs as secrets.

---

## `GET|POST /api/shelly` — Shelly device webhook

The main ingest endpoint. Accepts GET **and** POST with identical semantics (Shelly devices fire
GET); all input is read from query parameters either way. On each hit the server caches the
device's last-known state, appends a history sample (paid tiers, telemetry only), and — on a real
flood/leak alarm — closes the vehicle's LinkTap valves and pushes alerts.

### Query parameters

| Param | Required | Meaning |
| --- | --- | --- |
| `vid` | yes | Vehicle ID — must match a vehicle registered in the admin console |
| `key` | yes* | Instance API key (*unless auth is disabled) |
| `k` | no | Per-vehicle secret (hosted-service auth); optional on a self-hosted instance |
| `device` | no | Device ID; defaults to `unknown`. `/`, `#`, `?` are replaced with `_` |
| `event` | no | Event name; defaults to `sensor alert` (treated as a pushable alert) |
| anything else | no | Passthrough telemetry (e.g. `v`, `vraw`, `tC`) stored as the state's `extra` map; empty or literal `null` values are dropped |

`vid`, `event`, `device`, and `key` are reserved and never stored as telemetry.

### Event classification (from `src/events.ts`)

| Kind | Rule | Effect |
| --- | --- | --- |
| Flood/leak alarm | matches `/flood\|leak\|alarm/i`, does **not** end in `_off`/`.off`, not telemetry | Valve shutoff + push. Never throttled |
| Telemetry | ends in `.measurement` or `.change` (case-insensitive) | Cached + history; never pushes |
| Alarm cleared | ends in `_off` or `.off` (e.g. `flood.alarm_off`) | Cached; pushes as a generic alert, no shutoff |
| Anything else | — | Cached; pushes as a generic sensor alert |

Telemetry persistence is throttled by the vehicle's tier (flood/alarm events always persist):
free = one sample per 30 min, basic = 5 min, premium = 1 min. An unset/unknown tier gets premium
resolution. On a self-hosted server the tier is whatever you assign the vehicle in `/admin` — it
exists only as a throttling/retention knob, so `premium` (or unset) is the sensible choice.

### Examples

Flood alarm (closes the valve, pushes an alert):

```bash
curl "https://guardian.example.com/api/shelly?vid=boat1&device=shellyflood-a1b2c3&event=flood.alarm&key=YOUR_API_KEY"
```

```json
{
  "status": "ok",
  "event": "flood.alarm",
  "telemetry": false,
  "persisted": true,
  "notified": 1,
  "pushFailed": 0,
  "shutoff": { "ok": true, "valves": 1 }
}
```

Battery-voltage telemetry (cached + history, no push):

```bash
curl "https://guardian.example.com/api/shelly?vid=boat1&device=shellyuni-d4e5f6&event=voltmeter.measurement&v=12.6&key=YOUR_API_KEY"
```

```json
{
  "status": "ok",
  "event": "voltmeter.measurement",
  "telemetry": true,
  "persisted": true,
  "notified": 0,
  "pushFailed": 0,
  "shutoff": null
}
```

### Response fields

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `unauthorized`, `missing_vid`, or `vehicle_not_found` |
| `telemetry` | Whether the event classified as telemetry |
| `persisted` | `false` when the tier throttle skipped this telemetry tick |
| `notified` / `pushFailed` | FCM pushes accepted / attempted-but-failed (0/0 for telemetry) |
| `shutoff` | `null` unless a flood; else `{ ok, valves?, error? }` — `"no LinkTap config"` means the vehicle registration has no usable LinkTap credentials |

### Status codes

| Code | Body | Cause |
| --- | --- | --- |
| 200 | `{"status":"ok", …}` | Processed (even if shutoff/push had errors — check the fields) |
| 400 | `{"status":"missing_vid"}` | No `vid` param |
| 401 | `{"status":"unauthorized"}` | Wrong/missing `key`, or no API key configured yet (fails closed) |
| 404 | `{"status":"vehicle_not_found"}` | `vid` not registered under `/admin` |

### How Shelly webhooks are formed

You don't normally call this endpoint yourself. When you point the app at your server (Settings →
Vehicles → Advanced → Custom Cloud Server URL), the app writes outbound webhook URLs into each
Shelly device's action config, shaped like the examples above: your base URL + `/api/shelly` with
`vid`, `device`, and `key` baked in, and the event name plus telemetry values filled in by the
device when it fires. Battery-powered sensors (e.g. Shelly Flood) deep-sleep and only fire on
events and periodic wake-ups — they are never polled.

---

## `GET /api/history` — telemetry history

Returns stored history samples for one device. Same API-key auth as webhooks.

### Query parameters

| Param | Required | Meaning |
| --- | --- | --- |
| `vid` | yes | Vehicle ID |
| `device` | yes | Device ID (as stored — sanitized) |
| `since` | no | Epoch **milliseconds**; only samples at/after this time |
| `key` | yes* | Instance API key (*unless auth is disabled) |

### What gets stored (tier gating)

History is written only when a webhook is (a) telemetry, (b) carries at least one extra param, and
(c) survives the tier throttle. Retention is the vehicle tier's window — free **0 days (nothing
stored)**, basic 30, premium 1095 — optionally capped by the admin `retentionDays` setting
(0 = no cap). An unset tier is treated as premium. Samples older than 7 days are downsampled to
one per hour, and each device is hard-capped at 5000 samples.

### Example

```bash
curl "https://guardian.example.com/api/history?vid=boat1&device=shellyuni-d4e5f6&since=1750000000000&key=YOUR_API_KEY"
```

```json
{
  "vid": "boat1",
  "device": "shellyuni-d4e5f6",
  "samples": [
    { "at": 1750000123456, "extra": { "v": "12.6" } }
  ]
}
```

Samples are oldest-first. An unknown `vid`/`device` returns an empty `samples` array (not a 404).

### Status codes

| Code | Body | Cause |
| --- | --- | --- |
| 200 | `{ vid, device, samples }` | OK (possibly empty) |
| 400 | `{"error":"vid + device required"}` | Missing param |
| 401 | `{"status":"unauthorized"}` | Bad/missing key |

---

## `GET /healthz` — liveness

No auth. Returns `200 {"ok":true}`. Used by the Docker `HEALTHCHECK`.

```bash
curl http://localhost:3030/healthz
```

---

## Admin console (separate port, HTTP Basic auth)

The admin console runs on its **own listener** at `ADMIN_PORT` (default `3031`), not on the public
API port. The static UI is served at the root of that port (`http://<host>:3031/`), and the JSON
endpoints live under `/admin/api/*` on the same port. Everything under `/admin/api/*` requires Basic
auth: any username, password = `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is not set, those requests are
denied (401) — the server never exposes an unprotected admin API.

The UI drives the JSON endpoints below: set the API key, toggle unauthenticated mode, set the
retention cap, register vehicles (with LinkTap credentials), and map users to FCM tokens. Examples
below use `localhost:3031` since admin is typically reached on the host / private network rather than
published to the internet.

### `GET /admin/api/status`

```bash
curl -u admin:$ADMIN_PASSWORD http://localhost:3031/admin/api/status
```

```json
{
  "apiKeySet": true,
  "allowUnauthenticated": false,
  "retentionDays": null,
  "vehicles": [ { "vid": "boat1", "name": "Sea Breeze", "tier": "premium", "users": 1 } ]
}
```

`retentionDays` is `null` when no cap is set. The API key itself is never returned.

### `POST /admin/api/settings`

All fields optional; only supplied fields are changed.

```bash
curl -u admin:$ADMIN_PASSWORD -H 'Content-Type: application/json' \
  -d '{"apiKey":"a-long-random-string","allowUnauthenticated":false,"retentionDays":365}' \
  http://localhost:3031/admin/api/settings
```

Returns `{"ok":true}`, or `400 {"error":"bad json"}`.

### `POST /admin/api/vehicle`

Registers or replaces a vehicle (upsert by `vid` — the whole record is overwritten, so resend the
full config when updating). `tier` must be `free`, `basic`, or `premium`; anything else is stored
as unset (which behaves as premium). `linktap` is required for cloud valve shutoff to work.

```bash
curl -u admin:$ADMIN_PASSWORD -H 'Content-Type: application/json' -d '{
  "vid": "boat1",
  "name": "Sea Breeze",
  "tier": "premium",
  "allowedUsers": ["uid-1"],
  "linktap": {
    "username": "linktap-account",
    "apiKey": "linktap-api-key",
    "gatewayId": "GATEWAY_ID",
    "taplinkerIds": ["TAPLINKER_ID"]
  }
}' http://localhost:3031/admin/api/vehicle
```

Returns `{"ok":true,"vid":"boat1"}`, or `400 {"error":"vid required"}`.

### `POST /admin/api/user-token`

Maps a user ID to an FCM registration token (one token per user; upsert). Push alerts for a
vehicle go to every `allowedUsers` entry that has a token mapped here.

```bash
curl -u admin:$ADMIN_PASSWORD -H 'Content-Type: application/json' \
  -d '{"uid":"uid-1","token":"FCM_REGISTRATION_TOKEN"}' \
  http://localhost:3031/admin/api/user-token
```

Returns `{"ok":true}`, or `400 {"error":"uid + token required"}`.

Unknown `/admin/api/*` paths (or wrong methods) return `404 {"error":"unknown admin endpoint"}`.

---

## Cloudflare Worker adapter differences

The Worker (`src/worker.ts`) serves `GET|POST /api/shelly` and `GET /api/history` with the same
contract, and answers health checks on **both** `/api/health` and `/healthz` with
`{"ok":true,"service":"brvg-cloud-server","time":<epoch ms>}`. It has **no `/admin` surface** —
settings and vehicles must be written to the D1 database directly (see
[DEPLOYMENT.md](DEPLOYMENT.md#cloudflare-worker--d1)).
