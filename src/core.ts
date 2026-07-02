// Transport-agnostic webhook handler. The Node adapter (and, later, a Cloudflare adapter) build the
// `Deps` and call this. All I/O is injected, so the safety-critical decision logic is fully unit-
// testable without standing up a network, DB, or device — see core.test.ts.

import {
  isFloodShutoff, isTelemetry, extractSensorStateExtras, sanitizeDevice,
  telemetryResolutionSecForTier, shouldPersistTelemetry, TELEMETRY_RESOLUTION_SEC,
  historyRetentionDaysForTier,
} from './events.js';
import { keyAuthorized, classifyVehicleWebhookAuth, WEBHOOK_AUTH_REQUIRED } from './auth.js';
import { parseMessagingPrefs, recipientsForEvent } from './messaging.js';
import type { Deps, WebhookResult, ShutoffResult, Tier } from './types.js';

export interface ShellyWebhookInput {
  vid: string | null;
  event: string;
  device: string | null;
  /** Telemetry params the device embedded (everything except vid/event/device/key). */
  params: Iterable<[string, string]>;
  /** Instance auth key from the request (?key= or header), or null — gates a whole self-host instance. */
  key?: string | null;
  /** Per-vehicle webhook secret from the request (?k=), or null (SEC-4). */
  k?: string | null;
}

/**
 * Handle a Shelly sensor webhook: cache state, on a real flood close the LinkTap valve, and push an
 * alert to the vehicle's users. Mirrors the Cloudflare worker, but with injected deps + local auth.
 */
export async function handleShellyWebhook(input: ShellyWebhookInput, deps: Deps): Promise<WebhookResult> {
  const { storage, notify, linktap, now, log } = deps;

  // Auth: self-host servers are public endpoints, so the API key is how a device proves it belongs to
  // this instance. FAILS CLOSED — a key-less instance rejects webhooks unless the operator explicitly
  // set allowUnauthenticated=true (see keyAuthorized). Timing-safe compare.
  const requiredKey = await storage.getSetting('apiKey');
  const allowUnauth = (await storage.getSetting('allowUnauthenticated')) === 'true';
  if (!keyAuthorized(requiredKey, allowUnauth, input.key)) {
    return { status: 'unauthorized' };
  }

  if (!input.vid) return { status: 'missing_vid' };
  const vehicle = await storage.getVehicle(input.vid);
  if (!vehicle) return { status: 'vehicle_not_found' };

  // Per-vehicle webhook auth (SEC-4). Phase 1: a vehicle with a webhookSecret whose request omits/mismatches
  // `k` is still processed, but the state is reported so migration is observable. Once every device has
  // re-registered with `&k=`, flip WEBHOOK_AUTH_REQUIRED to reject 'unauthenticated'.
  const vehicleAuth = classifyVehicleWebhookAuth(vehicle.webhookSecret, input.k);
  if (WEBHOOK_AUTH_REQUIRED && vehicleAuth === 'unauthenticated') {
    return { status: 'unauthorized', vehicleAuth };
  }
  if (vehicleAuth === 'unauthenticated') {
    log?.(`vehicle ${input.vid}: webhook missing/invalid per-vehicle secret (accepted — Phase 1)`);
  }

  const event = input.event || 'sensor alert';
  const device = sanitizeDevice(input.device);
  const isFlood = isFloodShutoff(event);
  const telemetry = isTelemetry(event);
  const nowMs = now();
  const extra = extractSensorStateExtras(input.params);

  // Enforce tier device limits (Free: 3, Basic: 6, Premium: 20)
  const limitForTier = (tier?: Tier) => (tier === 'free' ? 3 : tier === 'basic' ? 6 : 20);
  const prev = await storage.getSensorState(input.vid, device);
  if (!prev) { // New device
    const linkTapCount = vehicle.linktap?.taplinkerIds?.length || 0;
    const shellyCount = await storage.countSensorStates(input.vid);
    if ((linkTapCount + shellyCount) >= limitForTier(vehicle.tier)) {
      return { status: 'device_limit_reached' } as unknown as WebhookResult;
    }
  }

  // Tier-aware persistence throttle — telemetry only; flood/alarm always persist.
  let persisted = true;
  const resolutionSec = telemetryResolutionSecForTier(vehicle.tier);
  if (telemetry && resolutionSec > TELEMETRY_RESOLUTION_SEC.premium) {
    persisted = shouldPersistTelemetry(nowMs, prev?.at ?? null, resolutionSec);
  }
  if (persisted) {
    await storage.putSensorState(input.vid, device, { event, at: nowMs, extra });
    // Append a history sample for paid tiers (retention enforced in storage). Only when there's
    // telemetry to chart, and only on a persisted tick (so history honors the same throttle). The
    // self-host admin's `retentionDays` setting, if set, CAPS the tier window (a storage-limit knob).
    if (telemetry && Object.keys(extra).length > 0) {
      const tierDays = historyRetentionDaysForTier(vehicle.tier);
      const adminCap = Number(await storage.getSetting('retentionDays')) || 0;
      const retentionDays = adminCap > 0 ? Math.min(tierDays, adminCap) : tierDays;
      if (retentionDays > 0) {
        await storage.appendHistory(input.vid, device, { at: nowMs, extra }, retentionDays * 86_400_000);
      }
    }
  }

  // SAFETY: on a real flood/leak, close every configured LinkTap valve (cloud fallback for when no
  // local app is running). Redundant closes are idempotent. Never throttled.
  let shutoff: ShutoffResult | null = null;
  if (isFlood) {
    const lt = vehicle.linktap;
    const taplinkers = (lt?.taplinkerIds || []).filter(Boolean);
    if (lt?.username && lt.apiKey && lt.gatewayId && taplinkers.length) {
      let okCount = 0; let lastErr = '';
      for (const tap of taplinkers) {
        try {
          await linktap.shutoff({ username: lt.username, apiKey: lt.apiKey, gatewayId: lt.gatewayId, taplinkerId: tap });
          okCount++;
        } catch (e: any) {
          lastErr = String(e?.message || e);
        }
      }
      shutoff = okCount === taplinkers.length
        ? { ok: okCount > 0, valves: okCount }
        : { ok: okCount > 0, valves: okCount, error: lastErr };
    } else {
      shutoff = { ok: false, error: 'no LinkTap config' };
    }
    log?.(`flood event ${event} on ${input.vid}: shutoff ${JSON.stringify(shutoff)}`);
  }

  // Push: real alerts only (telemetry never pushes). Count real FCM acceptances.
  let notified = 0; let pushFailed = 0;
  let messagesSent = 0; let messagesAttempted = 0;
  if (!telemetry) {
    const name = vehicle.name || 'your vehicle';
    const title = `🚨 ${name}`;
    const body = isFlood
      ? (shutoff?.ok ? 'Flood detected — valve closed automatically.' : `Flood detected: ${event}`)
      : `Sensor alert: ${event}`;
    for (const uid of vehicle.allowedUsers) {
      const token = await storage.getUserFcmToken(uid);
      if (token) {
        (await notify.sendPush(token, title, body)) ? notified++ : pushFailed++;
      }
    }

    if (deps.messageSenders && deps.messageSenders.length > 0) {
      for (const sender of deps.messageSenders) {
        let rawPrefs: string | undefined;
        if (sender.id === 'sms') rawPrefs = vehicle.sh_sms_prefs;
        else if (sender.id === 'whatsapp') rawPrefs = vehicle.sh_whatsapp_prefs;
        else if (sender.id === 'telegram') rawPrefs = vehicle.sh_telegram_prefs;
        
        const prefs = parseMessagingPrefs(rawPrefs);
        const recipients = recipientsForEvent(vehicle.tier, prefs, event);
        messagesAttempted += recipients.length;
        for (const to of recipients) {
          try {
            const r = await sender.sendMessage(to, body);
            if (r.ok) messagesSent++;
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return { status: 'ok', vehicleAuth, event, telemetry, persisted, notified, pushFailed, messagesSent, messagesAttempted, shutoff };
}
