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
