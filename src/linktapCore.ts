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

import { parseLinkTapWebhook, isAutoRecoverableAlarm, type LinkTapWebhookBody, type LinkTapKind } from './linktapEvents.js';
import { sanitizeDevice, telemetryResolutionSecForTier, shouldPersistTelemetry, TELEMETRY_RESOLUTION_SEC } from './events.js';
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
  /** True when this alarm would be auto-recovered (opt-in + benign). Actual clear/reopen: command slice. */
  autoRecover?: boolean;
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
  const extra: Record<string, string> = { kind: ev.kind };
  if (ev.watering !== undefined) extra.watering = ev.watering ? '1' : '0';
  if (ev.flow !== undefined) extra.flow = String(ev.flow);
  if (ev.battery !== undefined) extra.battery = String(ev.battery);
  if (ev.signal !== undefined) extra.signal = String(ev.signal);
  if (ev.workMode) extra.workMode = ev.workMode;
  if (ev.alarmCode) extra.alarm = ev.alarmCode;

  // Coalesce: throttle only the high-frequency telemetry stream (per tier); state/alarm always persist.
  let persisted = true;
  if (telemetry) {
    const resolutionSec = telemetryResolutionSecForTier(vehicle.tier);
    if (resolutionSec > TELEMETRY_RESOLUTION_SEC.premium) {
      const prev = await storage.getSensorState(vehicle.vid, device);
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

  // Auto-recover eligibility (opt-in + benign only). The actual dismissAlarm + reopen lands with the
  // command relay; here we just decide + report + log so behavior is observable.
  const autoRecover = ev.kind === 'alarm' && vehicle.linktapAutoRecover === true && isAutoRecoverableAlarm(ev.alarmCode ?? null);
  if (ev.kind === 'alarm') {
    log?.(`linktap alarm ${ev.name} on ${vehicle.vid}: autoRecover=${autoRecover} (recover wiring pending command slice)`);
  }

  return {
    status: 'ok', vid: vehicle.vid, event: ev.name, kind: ev.kind, persisted,
    notified, pushFailed, ntfied, messagesSent, messagesAttempted, autoRecover,
  };
}
