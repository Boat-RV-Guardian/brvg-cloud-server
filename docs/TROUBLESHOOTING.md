# Troubleshooting

Symptom → cause → fix, in the order problems usually show up. Endpoint details are in
[API.md](API.md); setup steps in [DEPLOYMENT.md](DEPLOYMENT.md).

The webhook response is your best debugging tool — every `/api/shelly` hit returns exactly what the
server did (`persisted`, `notified`, `pushFailed`, `shutoff`). Replay one with curl and read it.

## Quick health check

```bash
curl http://localhost:3030/healthz                       # → {"ok":true}
docker compose ps                                        # STATUS "healthy"?
docker compose logs -f brvg-cloud-server                 # live logs (flood events are logged)
curl -u admin:$ADMIN_PASSWORD http://localhost:3030/admin/api/status
```

`/admin/api/status` tells you at a glance whether the API key is set, auth is disabled, what the
retention cap is, and which vehicles exist.

## Webhooks not arriving

**Symptom:** the app shows stale/no remote state; nothing in the server logs when a sensor fires.

Work outward from the server:

| Cause | How to tell | Fix |
| --- | --- | --- |
| No API key set (fails closed) | `curl ".../api/shelly?vid=X"` → `401 {"status":"unauthorized"}`; `/admin` status line says webhooks BLOCKED | Set an API key under `/admin` — a fresh instance rejects everything until you do |
| Wrong key in the app / device URLs | Same 401, but `apiKeySet` is true | Re-enter the API key in the app (Settings → Vehicles → Advanced) so it rewrites the device webhooks |
| Vehicle not registered | `404 {"status":"vehicle_not_found"}` | Add the vehicle (exact `vid`) under `/admin` |
| Server unreachable from the vehicle's network | curl from a phone on the boat/RV Wi-Fi times out | Fix reachability: port forward / DNS / VPS / VPN — see [DEPLOYMENT.md](DEPLOYMENT.md#reachability-sensors--server). Remember CGNAT breaks home port-forwards |
| Sensor is asleep | Nothing arrives even though curl works | Battery Shelly sensors (Flood) **deep-sleep** and only report on events and periodic wake-ups — they are never polled. Trigger a test (wet the flood contacts, press the button) rather than waiting |
| Stale webhook config on the device | Other devices report, one doesn't | Re-run device setup from the app so it rewrites that device's webhook URLs |

## Valve doesn't close on flood

**Symptom:** flood alert fires but water keeps flowing; `shutoff` in the webhook response is not
`{"ok":true}`.

| Cause | How to tell | Fix |
| --- | --- | --- |
| No LinkTap credentials on the vehicle | `"shutoff":{"ok":false,"error":"no LinkTap config"}` | Edit the vehicle in `/admin` and fill in **all** of: LinkTap username, API key, gateway ID, taplinker ID(s). Cloud shutoff goes through LinkTap's cloud, not the local gateway |
| Wrong LinkTap credentials | `shutoff.error` contains a LinkTap API error | Verify username + API key at link-tap.com, and that the gateway/taplinker IDs are the ones for this vehicle |
| LinkTap cloud unreachable / down | `shutoff.error` is a fetch/network failure; flood line in server logs | Check the server's outbound internet; retry — redundant closes are idempotent |
| Event didn't classify as a flood | Response has `"shutoff":null` | Only events matching `flood|leak|alarm` (and not ending `_off`/`.off`, and not `.measurement`/`.change`) trigger shutoff. Check the `event` your device sends |

Test end-to-end without water: replay the device's flood URL with curl and watch the `shutoff`
field (this **really closes the valve** — pick a calm moment).

## Push notifications not arriving

**Symptom:** flood/alert events return `"notified":0` or a nonzero `pushFailed`.

Push is optional and has three prerequisites, all of which must hold:

| Cause | How to tell | Fix |
| --- | --- | --- |
| Firebase creds not configured | `notified:0, pushFailed>0` even though tokens are mapped; no FCM lines in logs | Set all three of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` in `.env` and restart. With any missing, the server silently uses a no-op notifier. The service account must belong to the same Firebase project the app registers its FCM tokens with |
| No FCM token mapped for the user | `notified:0, pushFailed:0` | Map the user ID to their token under `/admin` → "Map user → FCM token" |
| User not in the vehicle's allowed users | Same — 0/0 | Add the user ID to the vehicle's allowed-users list in `/admin` |
| Stale/invalid FCM token | `pushFailed>0`; logs show `FCM send failed: 4xx` | Re-register: get the current token from the app and re-map it |
| Private-key formatting | Logs show `FCM token error` | The PEM key must keep its newlines; `\n` escapes in `.env` are handled, but check quoting |

Note `notified`/`pushFailed` count only users that had a token; telemetry events never push.

## History is empty

**Symptom:** `/api/history` returns `"samples": []`; charts show nothing.

| Cause | How to tell | Fix |
| --- | --- | --- |
| Vehicle tier is `free` | `/admin/api/status` shows `"tier":"free"` | Free retains **0 days** — nothing is ever stored. Set the vehicle to `basic`/`premium` (or leave tier unset, which behaves as premium) |
| Admin retention cap | `retentionDays` set low in `/admin` | The cap **shrinks** the tier window (`min(tier, cap)`); set it to 0 to remove the cap |
| Events aren't telemetry | Webhook responses show `"telemetry":false` | Only events ending `.measurement`/`.change` **with at least one extra param** (e.g. `v=12.6`) are recorded. Alarms update state but not history |
| Tier throttle | `"persisted":false` in responses | Telemetry is sampled at the tier's resolution (free 30 min, basic 5 min, premium 1 min); skipped ticks don't append history |
| Wrong `vid`/`device` or `since` too recent | 200 with empty samples (never a 404) | Match the exact stored device ID; `since` is epoch **milliseconds** |

Retention windows apply at write time, and long-term samples are downsampled to hourly past 7 days
with a 5000-sample-per-device cap — old gaps in dense data are expected, not a bug.

## Admin login fails

**Symptom:** `/admin` keeps prompting or returns 401.

| Cause | How to tell | Fix |
| --- | --- | --- |
| `ADMIN_PASSWORD` not set | 401 no matter what you type | The server denies **all** admin access when the env var is unset. Set it in `.env` and restart |
| Wrong password | — | Only the password is checked; the username can be anything |
| Shell/compose quoting mangled the value | Special characters in the password | Quote it in `.env`, or pick a long alphanumeric password |
| Proxy stripping the `Authorization` header | Works on `localhost:3030`, fails through the proxy | Ensure the reverse proxy forwards `Authorization` (nginx does by default; check custom configs) |

## Container won't start / data not persisting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Compose exits with `set ADMIN_PASSWORD` | The compose file requires it (`:?` guard) | `cp .env.example .env` and set `ADMIN_PASSWORD` |
| Settings/vehicles gone after recreate | Data volume not mounted | Keep the `brvg-data:/app/data` volume and `DB_PATH=/app/data/brvg.json` (the shipped compose does). `docker compose down -v` deletes the volume — don't use `-v` casually |
| Permission errors writing the DB | Bind mount not writable by the container's `node` user (uid 1000) | `chown -R 1000:1000 <host-dir>`, or stick with the named volume |
| A `brvg.json.corrupt` file appears | The JSON db was unparseable at boot; the server preserved it and started fresh (so the instance is back to no-API-key, fails closed) | Recover what you can from the `.corrupt` file or restore a backup, then re-enter settings via `/admin` |
| Port already in use | Another service on 3030 | Change the host side of `ports:` in `docker-compose.yml`, or `PORT` for bare Node |

## Still stuck

Replay the exact failing request with curl and read the JSON — the server always says which step
failed. Server logs (`docker compose logs`) record every flood decision. If it still looks like a
bug, open an issue with the webhook response body and the relevant log lines (redact your key).
