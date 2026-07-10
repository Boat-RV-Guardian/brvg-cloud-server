/**
 * Pure role + command authorization for server-side control enforcement (open-tasks Task 4).
 *
 * Today role enforcement is CLIENT-side only (LinkTapWidget gates the buttons), so a `monitor`-role
 * user who holds the vehicle's cloud credentials could still call the LinkTap API directly. Routing
 * control commands through the worker — which verifies the caller's Firebase ID token and checks
 * their role against the vehicle's `members` map before relaying — closes that gap.
 *
 * This module is the pure decision layer (no I/O): resolve a role, decide if it may control, and
 * validate/normalize a command while enforcing the safety invariant that an OPEN must carry a bounded
 * limit (the valve can never run unbounded — the same self-limit the app always sends). The Firestore
 * read, ID-token verification, and LinkTap call live in index.ts.
 */

export type Role = 'admin' | 'control' | 'monitor';

function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'control' || v === 'monitor';
}

/**
 * Resolve a user's role for a vehicle from its `members` map, falling back to `allowedUsers`.
 * Mirrors the client's getMyRole(): a user listed in `allowedUsers` but absent from `members` is a
 * legacy member and treated as `admin` (the original owner, before per-member roles existed).
 * Returns null for a user with no access at all.
 */
export function resolveRole(
  members: Record<string, { role?: unknown } | undefined> | null | undefined,
  allowedUsers: readonly string[] | null | undefined,
  uid: string,
): Role | null {
  if (!uid) return null;
  const entry = members?.[uid];
  if (entry && isRole(entry.role)) return entry.role;
  if ((allowedUsers || []).includes(uid)) return 'admin'; // legacy owner backfill
  return null;
}

/** Control = admin or control. A monitor (or a user with no role) may NOT send device commands. */
export function canControl(role: Role | null): boolean {
  return role === 'admin' || role === 'control';
}

/**
 * Tier gate for remote (off-LAN) control (open-tasks Task 6, server side): remote control is a
 * paid feature — Basic and up. The client already skips the cloud relay for Free-plan vehicles;
 * this closes the bypass where a modified client calls /api/control directly.
 *
 * Applied to OPEN only. CLOSE is never tier-gated: shutting the valve can only prevent damage,
 * and the flood-shutoff safety chain must never be blocked by a plan check (the same reasoning
 * as validateControlCommand always allowing close). An unset/legacy tier is grandfathered
 * (mirrors retention.ts GRANDFATHERED_TIER='premium' / firestore.ts's read default).
 */
export function tierCanRemoteControl(tier: string | null | undefined): boolean {
  return tier !== 'free';
}

export type ControlAction = 'open' | 'close';

export interface ControlCommand {
  action: ControlAction;
  /** Required for `open`: how long the valve may stay open (the safety limit). */
  durationSec?: number;
  /** Optional additional volume cap for `open` (liters). */
  volumeLimitLiters?: number;
}

/** Result of validating a command — normalized to the LinkTap cloud API's units (minutes, liters). */
export interface CommandValidation {
  ok: boolean;
  error?: string;
  /** LinkTap `duration` in MINUTES (capped to the cloud API's 1439 max), present for a valid open. */
  durationMins?: number;
  /** LinkTap `vol` in liters, present only when a positive volume limit was supplied. */
  vol?: number;
}

/** LinkTap cloud API caps instant-mode duration at 1439 minutes (23h59m). */
export const LINKTAP_MAX_DURATION_MINS = 1439;

/**
 * Validate + normalize a control command. CLOSE is always allowed (no limit needed). OPEN must carry
 * a positive `durationSec` — enforcing server-side the invariant that the valve self-limits, so even
 * a compromised/buggy caller can't open it indefinitely. Duration is converted to whole minutes
 * (min 1, capped 1439) and an optional positive volume limit is passed through.
 */
export function validateControlCommand(cmd: ControlCommand): CommandValidation {
  if (cmd.action === 'close') return { ok: true };
  if (cmd.action !== 'open') return { ok: false, error: 'unknown action' };

  const durSec = Number(cmd.durationSec);
  if (!Number.isFinite(durSec) || durSec <= 0) {
    return { ok: false, error: 'open requires a positive durationSec limit' };
  }
  const durationMins = Math.min(LINKTAP_MAX_DURATION_MINS, Math.max(1, Math.round(durSec / 60)));

  const out: CommandValidation = { ok: true, durationMins };
  const vol = Number(cmd.volumeLimitLiters);
  if (Number.isFinite(vol) && vol > 0) out.vol = Math.round(vol);
  return out;
}
