// Transport-agnostic handler for LinkTap webhook callbacks (setWebHookUrl → /api/linktap).
//
// LinkTap is account-global: one webhook URL per LinkTap account, and each callback identifies the
// device only by gatewayId + deviceId (there is NO vid). So we resolve the vehicle by matching the
// gatewayId against each vehicle's stored `linktap.gatewayId`, then: coalesce the state into the same
// sensorState cache the app reads off-LAN, and push real alerts through the existing notify/ntfy/
// message pipeline. Telemetry (flowMeterValue/flowMeterStatus) and watering-state changes never push.
//
// Auto-recover (opt-in, benign alarms only) needs the LinkTap command client (dismissAlarm + reopen)
// which lands with the command-relay slice — here we only compute + report eligibility and log it.

import { parseLinkTapWebhook, isAutoRecoverableAlarm, type LinkTapWebhookBody, type LinkTapKind, type LinkTapAlarmCode } from './linktapEvents.js';
import { sanitizeDevice, telemetryResolutionSecForTier, shouldPersistTelemetry, TELEMETRY_RESOLUTION_SEC } from './events.js';
import { INSTANT_MODE_MAX_MIN } from './linktapCommands.js';
import type { Deps, VehicleConfig } from './types.js';

export interface LinkTapWebhookResult {
  status: 'ok' | 'ignored' | 'vehicle_not_found';
  reason?: string;
  vid?: string;
  event?: string;
  kind?: LinkTapKind;
  persisted?: boolean;
  notified?: number;
  pushFailed?: number;
  ntfied?: boolean;
  messagesSent?: number;
  messagesAttempted?: number;
  /** True when this alarm is eligible for auto-recovery (opt-in + benign). */
  autoRecover?: boolean;
  /** True when the auto-recovery (dismissAlarm + bounded reopen) actually ran on ≥1 valve. */
  recovered?: boolean;
}

const eqId = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Find the vehicle that owns this LinkTap gateway (ids are case-insensitive per the API). */
async function vehicleForGateway(deps: Deps, gatewayId: string): Promise<VehicleConfig | null> {
  if (!gatewayId) return null;
  // NOTE: linear scan for now (self-host has few vehicles; hosted D1/Firestore can add a gateway index later).
  const all = await deps.storage.listVehicles();
  return all.find((v) => eqId(v.linktap?.gatewayId, gatewayId)) ?? null;
}

export async function handleLinkTapWebhook(body: LinkTapWebhookBody | null | undefined, deps: Deps): Promise<LinkTapWebhookResult> {
  const { storage, notify, now, log } = deps;

  const ev = parseLinkTapWebhook(body);
  if (!ev) return { status: 'ignored', reason: 'unparseable' };
  if (!ev.gatewayId) return { status: 'ignored', reason: 'no gatewayId' };

  const vehicle = await vehicleForGateway(deps, ev.gatewayId);
  if (!vehicle) return { status: 'vehicle_not_found', event: ev.name };

  const device = `linktap_${sanitizeDevice(ev.deviceId || 'unknown')}`;
  const nowMs = now();
  const telemetry = ev.kind === 'telemetry';

  // Build the cached-state extras (strings only, like Shelly sensorState.extra).
  const eventExtra: Record<string, string> = { kind: ev.kind };
  if (ev.watering !== undefined) eventExtra.watering = ev.watering ? '1' : '0';
  if (ev.flow !== undefined) eventExtra.flow = String(ev.flow);
  if (ev.battery !== undefined) eventExtra.battery = String(ev.battery);
  if (ev.signal !== undefined) eventExtra.signal = String(ev.signal);
  if (ev.workMode) eventExtra.workMode = ev.workMode;
  if (ev.alarmCode) eventExtra.alarm = ev.alarmCode;

  // Read the last cached reading once (for the throttle AND the field merge below).
  const prev = await storage.getSensorState(vehicle.vid, device);

  // MERGE onto the last reading so a partial event (e.g. a battery-only telemetry tick) doesn't wipe
  // the known watering/flow state — newest value wins per key. Same rationale as the Shelly path.
  const extra = { ...(prev?.extra || {}), ...eventExtra };

  // Coalesce: throttle only the high-frequency telemetry stream (per tier); state/alarm always persist.
  let persisted = true;
  if (telemetry) {
    const resolutionSec = telemetryResolutionSecForTier(vehicle.tier);
    if (resolutionSec > TELEMETRY_RESOLUTION_SEC.premium) {
      persisted = shouldPersistTelemetry(nowMs, prev?.at ?? null, resolutionSec);
    }
  }
  if (persisted) {
    await storage.putSensorState(vehicle.vid, device, { event: ev.name, at: nowMs, extra });
  }

  // Alerts — real alerts only (telemetry/state never push), reusing the Shelly dispatch pipeline.
  let notified = 0, pushFailed = 0, messagesSent = 0, messagesAttempted = 0, ntfied = false;
  if (ev.pushWorthy) {
    const name = vehicle.name || 'your vehicle';
    const title = `🚨 ${name}`;
    const body2 = ev.content || ev.title || `LinkTap: ${ev.name}`;
    for (const uid of vehicle.allowedUsers) {
      const token = await storage.getUserFcmToken(uid);
      if (token) (await notify.sendPush(token, title, body2)) ? notified++ : pushFailed++;
    }
    if (deps.ntfy && vehicle.ntfyTopic) {
      ntfied = await deps.ntfy.send(
        { server: vehicle.ntfyServer || 'https://ntfy.sh', topic: vehicle.ntfyTopic, token: vehicle.ntfyToken },
        title, body2, 'high',
      );
    }
    if (deps.messageSenders?.length) {
      const { parseMessagingPrefs, recipientsForEvent } = await import('./messaging.js');
      for (const sender of deps.messageSenders) {
        const rawPrefs = sender.id === 'sms' ? vehicle.sh_sms_prefs
          : sender.id === 'whatsapp' ? vehicle.sh_whatsapp_prefs
          : sender.id === 'telegram' ? vehicle.sh_telegram_prefs : undefined;
        const recipients = recipientsForEvent(vehicle.tier, parseMessagingPrefs(rawPrefs), ev.name);
        messagesAttempted += recipients.length;
        for (const to of recipients) {
          try { if ((await sender.sendMessage(to, body2)).ok) messagesSent++; } catch { /* ignore */ }
        }
      }
    }
  }

  // Auto-recover (opt-in + BENIGN alarms only — noWater/low-flow; never high-flow/valve-broken/fall/
  // freeze; enforced by isAutoRecoverableAlarm). Clear the latch, then reopen for a bounded instant
  // (autoBack:true so a watering plan resumes afterward). We always still push the alert above.
  const autoRecover = ev.kind === 'alarm' && vehicle.linktapAutoRecover === true && isAutoRecoverableAlarm(ev.alarmCode ?? null);
  let recovered = false;
  if (autoRecover && ev.alarmCode) {
    recovered = await runAutoRecover(deps, vehicle, ev.deviceId, ev.alarmCode);
    log?.(`linktap auto-recover ${ev.name} on ${vehicle.vid}: recovered=${recovered}`);
  } else if (ev.kind === 'alarm') {
    log?.(`linktap alarm ${ev.name} on ${vehicle.vid}: notify-only (autoRecover eligible=${autoRecover})`);
  }

  return {
    status: 'ok', vid: vehicle.vid, event: ev.name, kind: ev.kind, persisted,
    notified, pushFailed, ntfied, messagesSent, messagesAttempted, autoRecover, recovered,
  };
}

/** dismissAlarm + bounded reopen for the alarming valve(s). Returns true if it ran on ≥1 valve. */
async function runAutoRecover(
  deps: Deps,
  vehicle: VehicleConfig,
  deviceId: string,
  alarm: LinkTapAlarmCode, // caller guarantees this is a benign code (isAutoRecoverableAlarm)
): Promise<boolean> {
  const lt = vehicle.linktap;
  const { linktap, log } = deps;
  if (!lt?.username || !lt.apiKey || !lt.gatewayId || !linktap.dismissAlarm || !linktap.open) return false;

  // Target the valve that alarmed (deviceId may be the 16-char prefix of an 18-char ValveLinker id).
  const all = (lt.taplinkerIds || []).filter(Boolean);
  const matched = all.filter((t) => t === deviceId || (deviceId && t.startsWith(deviceId)));
  const targets = matched.length ? matched : deviceId ? [deviceId] : all;

  let ok = false;
  for (const taplinkerId of targets) {
    const creds = { username: lt.username, apiKey: lt.apiKey, gatewayId: lt.gatewayId, taplinkerId };
    try {
      await linktap.dismissAlarm(creds, alarm);
      await linktap.open(creds, { durationMin: INSTANT_MODE_MAX_MIN, autoBack: true });
      ok = true;
    } catch (e: any) {
      log?.(`linktap auto-recover failed on ${taplinkerId}: ${e?.message || e}`);
    }
  }
  return ok;
}
