/**
 * Pure tier-maintenance logic for the daily worker cron (open-tasks Task 6 server-side enforcement):
 *
 *  1. Trial expiry — the admin console grants a Basic trial by writing `tier='basic'` + a numeric
 *     `trialEndsAt` (epoch ms). When that passes, the trial must lapse back to `free`. Resolving it
 *     server-side means the client needs NO change (it just reads `tier`), exactly as Task 6 planned.
 *  2. History retention — hosted monthly history rollups (`vehicles/{vid}/history/{deviceId}_{YYYY-MM}`)
 *     beyond the vehicle's tier window are pruned. Free keeps none (on-device only), Basic ~1 month,
 *     Premium ~3 years.
 *
 * Everything here is pure (no I/O) so it's unit-tested without Firestore; the cron in index.ts wires
 * these selectors to the Firestore list/patch/delete calls.
 *
 * NOTE: HISTORY_RETENTION_DAYS mirrors TIER_FEATURES.historyRetentionDays in
 * dashboard/src/utils/entitlements.ts (and TELEMETRY_RESOLUTION_SEC mirrors it for the throttle).
 * Duplicated only until the shared self-host core lands (Task 7); keep them in sync.
 */

export type Tier = 'free' | 'basic' | 'premium';

/** Hosted-history retention window per tier, in days. Mirrors entitlements.ts. */
export const HISTORY_RETENTION_DAYS: Record<Tier, number> = {
  free: 0, // on-device only — no hosted history retained
  basic: 30, // ~1 month
  premium: 1095, // ~3 years
};

/** Tier assumed for a vehicle with no/invalid `tier` (legacy). Mirrors GRANDFATHERED_TIER='premium'. */
export const GRANDFATHERED_TIER: Tier = 'premium';

function isTier(v: unknown): v is Tier {
  return v === 'free' || v === 'basic' || v === 'premium';
}

/** Retention days for a (possibly unknown/legacy) tier — legacy grandfathers to premium (keep all). */
export function historyRetentionDaysForTier(tier: string | null | undefined): number {
  return HISTORY_RETENTION_DAYS[isTier(tier) ? tier : GRANDFATHERED_TIER];
}

/**
 * True if a Basic trial has lapsed: a finite, positive `trialEndsAt` that is now in the past. A
 * missing / non-positive / non-finite value means "no active trial marker" → not expired (nothing to
 * sweep). The cron only ACTS on a vehicle that currently carries `trialEndsAt`.
 */
export function isTrialExpired(trialEndsAtMs: number | null | undefined, nowMs: number): boolean {
  if (trialEndsAtMs == null || !Number.isFinite(trialEndsAtMs) || trialEndsAtMs <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs > trialEndsAtMs;
}

/** Length of the one-month free Basic trial, in days. Mirrors BASIC_TRIAL_DAYS in entitlements.ts. */
export const BASIC_TRIAL_DAYS = 30;

/**
 * Anti-abuse eligibility for the one-month free Basic trial (open-tasks Task 6). The decided rule:
 * a trial may be granted for `vid` ONLY when
 *   (a) the user has not already trialed this vehicle — `vid` is absent from their
 *       `users/{uid}.trialsUsed` (blocks re-adding a removed vehicle / farming across users), AND
 *   (b) the vehicle has never carried a `trialEndsAt` at all — even a long-expired one blocks a
 *       re-trial (blocks farming a fresh trial onto an old vehicle).
 * Pure so it can gate any grant path (the user's opt-in "Start free trial", the admin "Start trial" action).
 */
export function isTrialEligible(
  vid: string,
  userTrialsUsed: readonly string[] | null | undefined,
  vehicleTrialEndsAt: number | null | undefined,
): boolean {
  if (!vid) return false;
  const alreadyTrialedByUser = Array.isArray(userTrialsUsed) && userTrialsUsed.includes(vid);
  const vehicleEverTrialed =
    vehicleTrialEndsAt != null && Number.isFinite(vehicleTrialEndsAt) && vehicleTrialEndsAt > 0;
  return !alreadyTrialedByUser && !vehicleEverTrialed;
}

/** The `trialEndsAt` (epoch ms) a Basic trial granted at `nowMs` should carry. */
export function trialEndsAtFrom(nowMs: number): number {
  return nowMs + BASIC_TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

/** "YYYY-MM" (UTC) for an epoch-ms instant. */
export function monthOfUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * The oldest month (UTC "YYYY-MM") to KEEP for a retention window as of `nowMs`. Any history doc
 * whose month is lexicographically < this is prunable. Returns:
 *   - `''`  when retentionDays <= 0  → keep NOTHING (free: hosted history not allowed; prune all).
 *   - a month string otherwise.
 * We cut on whole months and keep the cutoff month itself, erring toward KEEPING in-window data
 * (a doc straddling the boundary keeps up to ~1 extra month rather than dropping live data).
 */
export function retentionCutoffMonth(nowMs: number, retentionDays: number): string {
  if (!(retentionDays > 0)) return '';
  return monthOfUTC(nowMs - retentionDays * 86_400_000);
}

/** Parse the trailing "YYYY-MM" month out of a history doc id (`{deviceId}_{YYYY-MM}`), or null. */
export function monthFromHistoryId(id: string): string | null {
  const m = /(\d{4}-\d{2})$/.exec(id);
  return m ? m[1] ?? null : null;
}

/**
 * Given history doc ids and a retention window, return the ids to DELETE.
 *   - retentionDays <= 0 → every id (free tier: no hosted history).
 *   - otherwise → ids whose month is strictly older than the cutoff month.
 * Ids without a parseable month are NEVER deleted (conservative — unknown shape is left alone).
 */
export function historyDocsToPrune(ids: string[], retentionDays: number, nowMs: number): string[] {
  if (!(retentionDays > 0)) return [...ids];
  const cutoff = retentionCutoffMonth(nowMs, retentionDays);
  return ids.filter((id) => {
    const month = monthFromHistoryId(id);
    return month != null && month < cutoff;
  });
}
