// Pure request builders + guards for the LinkTap command APIs (V1.6). No I/O — the network call lives
// in linktap.ts (LinkTapCloud). Kept pure so the exact request shape is unit-tested without hitting
// LinkTap: this is where we encode the two things that bit us before —
//   1) activateInstantMode has NO volume parameter (our old `vol` was invalid and part of the 400);
//      the valve is bounded by `duration` (+ the hardware self-limit), not a cloud volume cap.
//   2) all activate/pause calls are rate-limited to one per 15s.

export interface LinkTapCreds {
  username: string;
  apiKey: string;
  gatewayId: string;
  taplinkerId: string;
}

/** Watering-plan modes (each pre-configured in the LinkTap app; the API only activates them). */
export type PlanMode = 'interval' | 'oddEven' | 'sevenDay' | 'month' | 'calendar';

/** dismissAlarm codes. */
export type AlarmCode = 'noWater' | 'valveBroken' | 'pbFlag' | 'pcFlag' | 'fallFlag';

const BASE = 'https://www.link-tap.com/api';
/** activateInstantMode duration ceiling (minutes). ~24h; "always open" must use a plan or re-issue. */
export const INSTANT_MODE_MAX_MIN = 1439;
/** LinkTap rate-limits the activate/pause APIs to one call per 15 seconds. */
export const LINKTAP_MIN_COMMAND_INTERVAL_MS = 15_000;

export const ENDPOINTS = {
  instant: `${BASE}/activateInstantMode`,
  dismissAlarm: `${BASE}/dismissAlarm`,
  pause: `${BASE}/pauseWateringPlan`,
  interval: `${BASE}/activateIntervalMode`,
  oddEven: `${BASE}/activateOddEvenMode`,
  sevenDay: `${BASE}/activateSevenDayMode`,
  month: `${BASE}/activateMonthMode`,
  calendar: `${BASE}/activateCalendarMode`,
  setWebhook: `${BASE}/setWebHookUrl`,
  deleteWebhook: `${BASE}/deleteWebHookUrl`,
  getApiKey: `${BASE}/getApiKey`,
} as const;

/** Account-level credentials (username + apiKey) — for the webhook + key APIs (no per-valve id). */
export interface LinkTapAccount {
  username: string;
  apiKey: string;
}

export function setWebhookBody(a: LinkTapAccount, webHookUrl: string): Record<string, unknown> {
  return { username: a.username, apiKey: a.apiKey, webHookUrl };
}

export function deleteWebhookBody(a: LinkTapAccount): Record<string, unknown> {
  return { username: a.username, apiKey: a.apiKey };
}

/**
 * getApiKey body: username + PASSWORD (optionally `replace:true` to rotate). The password is used for
 * this one call only — callers MUST NOT persist it (store only the returned key). Onboarding runs this
 * once and discards the password.
 */
export function getApiKeyBody(username: string, password: string, replace = false): Record<string, unknown> {
  return replace ? { username, password, replace: true } : { username, password };
}

export function planEndpoint(mode: PlanMode): string {
  return ENDPOINTS[mode];
}

function creds(c: LinkTapCreds) {
  return { username: c.username, apiKey: c.apiKey, gatewayId: c.gatewayId, taplinkerId: c.taplinkerId };
}

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

export interface InstantOpts {
  /** Watering duration in minutes (open only). Clamped to [1, 1439]. */
  durationMin?: number;
  /** ECO cycling: valve ON `ecoOnMin` / OFF `ecoOffMin` within the duration. */
  ecoOnMin?: number;
  ecoOffMin?: number;
  /** Re-activate the previous watering plan after this instant session ends (default true). */
  autoBack?: boolean;
}

/**
 * Build an activateInstantMode body. `action=true` opens for `durationMin` (clamped 1–1439),
 * `action=false` closes (duration 0). NEVER emits a `vol` field (not a valid parameter).
 */
export function instantModeBody(c: LinkTapCreds, action: boolean, opts: InstantOpts = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...creds(c),
    action,
    duration: action ? clampInt(opts.durationMin ?? INSTANT_MODE_MAX_MIN, 1, INSTANT_MODE_MAX_MIN) : 0,
    autoBack: opts.autoBack ?? true,
  };
  if (action && opts.ecoOnMin && opts.ecoOffMin && opts.ecoOnMin > 0 && opts.ecoOffMin > 0) {
    body.eco = true;
    body.ecoOn = clampInt(opts.ecoOnMin, 1, INSTANT_MODE_MAX_MIN);
    body.ecoOff = clampInt(opts.ecoOffMin, 1, INSTANT_MODE_MAX_MIN);
  }
  return body;
}

export function dismissAlarmBody(c: LinkTapCreds, alarm: AlarmCode): Record<string, unknown> {
  return { ...creds(c), alarm };
}

export function planBody(c: LinkTapCreds): Record<string, unknown> {
  return creds(c);
}

export interface PauseOpts {
  /** Pause length in hours: 0.1–240, or -1 for an indefinite pause. */
  pauseHours: number;
  allDevice?: boolean;
  overwrite?: 'never' | 'always' | 'ifTemporary';
}

/** Build a pauseWateringPlan body; clamps pauseHours to the documented range (or -1 indefinite). */
export function pauseBody(c: LinkTapCreds, opts: PauseOpts): Record<string, unknown> {
  const raw = opts.pauseHours;
  const pauseDuration = raw === -1 ? -1 : Math.max(0.1, Math.min(240, raw));
  const body: Record<string, unknown> = { ...creds(c), pauseDuration };
  if (opts.allDevice) body.allDevice = true;
  if (opts.overwrite) body.overwrite = opts.overwrite;
  return body;
}

/** True if a command sent now would violate LinkTap's 15s min interval since the last one. */
export function isRateLimited(lastAtMs: number | null | undefined, nowMs: number): boolean {
  if (lastAtMs == null || !Number.isFinite(lastAtMs)) return false;
  return nowMs - lastAtMs < LINKTAP_MIN_COMMAND_INTERVAL_MS;
}
