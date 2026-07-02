// Shared auth helpers for the self-host server. Kept tiny + transport-agnostic so the Node server,
// the Cloudflare worker adapter, and core all share one (timing-safe, fail-closed) decision.

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Returns false on a null/undefined operand or a length mismatch
 * (the length of these secrets is not itself sensitive here). Avoids the early-exit timing leak of
 * `a === b` when comparing API keys / passwords.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Decide whether a webhook/history request key authorizes access.
 *
 * FAILS CLOSED: if the instance has no `apiKey` configured, access is DENIED unless the operator has
 * explicitly opted out by setting `allowUnauthenticated=true`. This closes the previous fail-open hole
 * where a fresh, key-less instance silently accepted unauthenticated webhooks (valve close / push spam
 * / history read) from anyone who knew a registered vid.
 */
export function keyAuthorized(
  requiredKey: string | null | undefined,
  allowUnauthenticated: boolean,
  presentedKey: string | null | undefined,
): boolean {
  if (!requiredKey) return allowUnauthenticated;
  return safeEqual(presentedKey, requiredKey);
}

// — Per-vehicle webhook auth (SEC-4, phased — see the main repo's docs/SEC4_WEBHOOK_AUTH.md) ——————————
//
// Distinct from the instance `apiKey` above (which gates a whole self-host instance): in the HOSTED,
// multi-tenant deployment, different owners' devices hit ONE worker, so each vehicle carries its own
// `webhookSecret`, sent by the device as `&k=<secret>`. Shelly fires a static URL and can't sign
// requests, so a URL bearer secret is the strongest thing it can carry. Rollout is phased so a
// provisioned device never breaks:
//   'legacy'          — the vehicle has no webhookSecret (not migrated). Always accepted.
//   'ok'              — a webhookSecret is set and the request's `k` matches.
//   'unauthenticated' — a webhookSecret is set but `k` is missing/wrong. Phase 1 ACCEPTS (records the
//                       state so migration is observable); flipping WEBHOOK_AUTH_REQUIRED rejects them.

export type VehicleWebhookAuthState = 'legacy' | 'ok' | 'unauthenticated';

/** Classify a webhook request's per-vehicle auth given the vehicle's secret and the presented `k`. */
export function classifyVehicleWebhookAuth(
  webhookSecret: string | null | undefined,
  providedK: string | null | undefined,
): VehicleWebhookAuthState {
  if (!webhookSecret) return 'legacy';
  return safeEqual(providedK, webhookSecret) ? 'ok' : 'unauthenticated';
}

/**
 * Phase toggle for SEC-4. While false (Phase 1), an 'unauthenticated' request is accepted (the state is
 * still reported) so provisioned devices keep working until they re-register with `&k=`. Flip to true
 * (Phase 2) ONLY once every active vehicle's devices have re-registered.
 */
export const WEBHOOK_AUTH_REQUIRED = false;
