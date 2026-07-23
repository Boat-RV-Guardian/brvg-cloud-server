// Debounce for LinkTap connectivity ("gateway/device offline / online") alerts.
//
// THE PROBLEM: LinkTap gateways flap. A brief Wi-Fi or LinkTap-cloud hiccup emits "gateway offline"
// and then "gateway online" seconds later. The old path pushed on every offline and stayed silent on
// online, so you got a stream of "disconnected" notifications while the gateway was perfectly fine.
//
// THE FIX: debounce. When an offline arrives we record WHEN it went offline and stay silent. A short
// cron promotes it to a single alert only if it's STILL offline past a grace window. When it comes
// back we clear the state and push a "reconnected" notice ONLY if we'd previously alerted — so a real
// outage reads clean (one offline, later one back-online) and a flap produces nothing at all.
//
// State rides in the connectivity sensorState doc's `extra` (strings only, like every other extra):
//   connState      'online' | 'offline'  — last observed connectivity
//   offlineSince   epoch ms it went offline (present only while offline)
//   offlineAlerted '1' once the sustained-offline alert has fired for this episode

/** Grace window before a sustained outage is worth a push. Owner: "30 min plus". */
export const GATEWAY_OFFLINE_GRACE_MS = 30 * 60 * 1000;

/** LinkTap connectivity names all contain "offline"/"online"; offline direction is what we debounce. */
export function isConnectivityOffline(name: string): boolean {
  return /offline/i.test(name);
}

export type ConnPush = 'none' | 'recovered';

/**
 * Fold a connectivity event into the stored debounce state. Returns the new extra and whether to push
 * NOW. Offline never pushes now (the cron promotes a sustained outage); online pushes a recovery notice
 * only if we'd previously alerted. Pure — the handler persists `extra` and acts on `push`.
 */
export function onConnectivityEvent(
  prev: Record<string, string>,
  name: string,
  nowMs: number,
): { extra: Record<string, string>; push: ConnPush } {
  const next = { ...prev };
  if (isConnectivityOffline(name)) {
    // Keep the ORIGINAL offline time across repeated offline events so the grace window measures the
    // whole episode, not the latest blip.
    if (!next.offlineSince) next.offlineSince = String(nowMs);
    next.connState = 'offline';
    return { extra: next, push: 'none' };
  }
  const wasAlerted = next.offlineAlerted === '1';
  delete next.offlineSince;
  delete next.offlineAlerted;
  next.connState = 'online';
  return { extra: next, push: wasAlerted ? 'recovered' : 'none' };
}

/**
 * For the cron sweep: is this connectivity state a sustained outage we haven't alerted yet? True only
 * when it's been offline continuously for at least the grace window.
 */
export function shouldAlertSustainedOffline(
  extra: Record<string, string> | undefined | null,
  nowMs: number,
  graceMs = GATEWAY_OFFLINE_GRACE_MS,
): boolean {
  if (!extra || extra.connState !== 'offline' || extra.offlineAlerted === '1') return false;
  const since = Number(extra.offlineSince);
  if (!Number.isFinite(since) || since <= 0) return false;
  return nowMs - since >= graceMs;
}

/** How long (whole minutes) a state has been offline, for the alert body. */
export function offlineMinutes(extra: Record<string, string> | undefined | null, nowMs: number): number {
  const since = Number(extra?.offlineSince);
  if (!Number.isFinite(since) || since <= 0) return 0;
  return Math.max(0, Math.round((nowMs - since) / 60000));
}
