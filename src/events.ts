// Pure event classification + telemetry throttling. Ported verbatim (behavior) from the Cloudflare
// worker's events.ts so the two stay in lockstep until a shared package unifies them. No I/O here.

export const FLOOD_EVENT_RE = /flood|leak|alarm/i;
export const TELEMETRY_EVENT_RE = /\.(measurement|change)$/i;
export const ALARM_CLEARED_RE = /(?:_off|\.off)$/i;

/** Periodic telemetry that should be cached but never pushed/triggered. */
export function isTelemetry(event: string): boolean {
  return TELEMETRY_EVENT_RE.test(event);
}

/** "Cleared/off" variant of an alarm (e.g. flood.alarm_off). */
export function isAlarmCleared(event: string): boolean {
  return ALARM_CLEARED_RE.test(event);
}

/** True only for a real flood/leak alarm that should close the valve. */
export function isFloodShutoff(event: string): boolean {
  return FLOOD_EVENT_RE.test(event) && !isAlarmCleared(event) && !isTelemetry(event);
}

export const RESERVED_PARAMS: ReadonlySet<string> = new Set(['vid', 'event', 'device', 'key']);

/** Extract device-embedded telemetry params (skip routing/auth params + unset placeholders). */
export function extractSensorStateExtras(searchParams: Iterable<[string, string]>): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, val] of searchParams) {
    if (RESERVED_PARAMS.has(k)) continue;
    if (val === '' || val === 'null') continue;
    extra[k] = val;
  }
  return extra;
}

/** Sanitize a device id for use as a storage key. */
export function sanitizeDevice(device: string | null | undefined): string {
  return (device || 'unknown').replace(/[\/#?]/g, '_');
}

// — Tier-aware telemetry persistence throttle (cost lever; mirrors the app's entitlement matrix). —
export const TELEMETRY_RESOLUTION_SEC: Record<'free' | 'basic' | 'premium', number> = {
  free: 1800,
  basic: 300,
  premium: 60,
};

export function telemetryResolutionSecForTier(tier: string | null | undefined): number {
  if (tier === 'free' || tier === 'basic' || tier === 'premium') return TELEMETRY_RESOLUTION_SEC[tier];
  return TELEMETRY_RESOLUTION_SEC.premium;
}

export function shouldPersistTelemetry(nowMs: number, lastAtMs: number | null | undefined, resolutionSec: number): boolean {
  if (lastAtMs == null || !Number.isFinite(lastAtMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - lastAtMs >= resolutionSec * 1000;
}

// Hosted history retention window per tier (mirrors the app's entitlement matrix). Free keeps none.
export const HISTORY_RETENTION_DAYS: Record<'free' | 'basic' | 'premium', number> = {
  free: 0,
  basic: 30,
  premium: 1095,
};

export function historyRetentionDaysForTier(tier: string | null | undefined): number {
  if (tier === 'free' || tier === 'basic' || tier === 'premium') return HISTORY_RETENTION_DAYS[tier];
  return HISTORY_RETENTION_DAYS.premium; // legacy/unset → grandfathered to premium
}

/** Keep raw (per-tick) samples for this many days; older samples are collapsed to hourly. */
export const RAW_HISTORY_WINDOW_DAYS = 7;
const HOUR_MS = 3_600_000;

/**
 * Collapse history to bound long-term storage (cost analysis §4): samples newer than `rawWindowMs`
 * are kept as-is; older ones are downsampled to ONE per hour (the latest in each hour bucket). Pure;
 * input may be in any order, output is oldest-first.
 */
export function downsampleHistory<T extends { at: number }>(samples: T[], nowMs: number, rawWindowMs: number): T[] {
  const cutoff = nowMs - rawWindowMs;
  const recent: T[] = [];
  const byHour = new Map<number, T>();
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    if (s.at >= cutoff) recent.push(s);
    else byHour.set(Math.floor(s.at / HOUR_MS), s); // oldest-first → last write per hour wins
  }
  return [...byHour.values(), ...recent].sort((a, b) => a.at - b.at);
}
