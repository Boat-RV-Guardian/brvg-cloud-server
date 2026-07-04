// Transport-agnostic types shared by the core handler and its adapters.

import type { LinkTapCreds, InstantOpts, AlarmCode, PlanMode, PauseOpts } from './linktapCommands.js';

export type Tier = 'free' | 'basic' | 'premium';

/** A vehicle's config as the server needs it (subset of the app's vehicle doc). */
export interface VehicleConfig {
  vid: string;
  name?: string;
  tier?: Tier;
  /** UIDs allowed to receive alerts for this vehicle. */
  allowedUsers: string[];
  /** LinkTap cloud credentials + valve ids for cloud-side shutoff. */
  linktap?: {
    username?: string;
    apiKey?: string;
    gatewayId?: string;
    taplinkerIds?: string[];
  };
  /** Per-vehicle webhook bearer secret (SEC-4). Devices send it as `&k=`; verified per request. */
  webhookSecret?: string;
  /** JSON string representing SmsPrefs */
  sh_sms_prefs?: string;
  /** JSON string representing WhatsappPrefs */
  sh_whatsapp_prefs?: string;
  /** JSON string representing TelegramPrefs */
  sh_telegram_prefs?: string;
  /** ntfy free-push topic for this vehicle (blank ⇒ no ntfy push). Users subscribe to it in the ntfy app. */
  ntfyTopic?: string;
  /** ntfy server base URL (blank ⇒ https://ntfy.sh). */
  ntfyServer?: string;
  /** Optional ntfy access token (for a protected topic/instance). */
  ntfyToken?: string;
  /**
   * Opt-in: on a *benign* LinkTap alarm (water cut-off / low flow) the server auto-clears it and
   * reopens (with a notification). Default off → notify + leave closed. High-flow / valve-broken /
   * device-fall / freeze never auto-recover regardless (see isAutoRecoverableAlarm).
   */
  linktapAutoRecover?: boolean;
}

/** Cached last-known state for a device (what the app reads when off-LAN). */
export interface SensorState {
  event: string;
  at: number; // epoch ms
  extra: Record<string, string>; // embedded telemetry (v, vraw, tC, …)
}

/** One historical telemetry sample (for charts / trends on paid tiers). */
export interface HistorySample {
  at: number; // epoch ms
  extra: Record<string, string>;
}

export interface ShutoffResult {
  ok: boolean;
  valves?: number;
  error?: string;
}

/** Persistence seam — Firestore (hosted) / SQLite / file (self-host) all implement this. */
export interface Storage {
  getVehicle(vid: string): Promise<VehicleConfig | null>;
  getSensorState(vid: string, device: string): Promise<SensorState | null>;
  putSensorState(vid: string, device: string, state: SensorState): Promise<void>;
  /** Returns the total number of unique sensor states (devices) tracking for this vehicle. */
  countSensorStates(vid: string): Promise<number>;
  /** Append a history sample, dropping anything older than `retentionMs` (0 = keep none). */
  appendHistory(vid: string, device: string, sample: HistorySample, retentionMs: number): Promise<void>;
  /** History samples for a device, optionally only those at/after `sinceMs`, oldest-first. */
  getHistory(vid: string, device: string, sinceMs?: number): Promise<HistorySample[]>;
  /** FCM registration token for a user (null if none). */
  getUserFcmToken(uid: string): Promise<string | null>;
  /** Instance settings (api key, retention window, etc.). */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  // — admin writes (self-host configuration) —
  listVehicles(): Promise<VehicleConfig[]>;
  putVehicle(v: VehicleConfig): Promise<void>;
  putUserFcmToken(uid: string, token: string): Promise<void>;
}

/** Push/notification seam (FCM today; SMS/voice later). */
export interface Notifier {
  /** Returns true if the provider accepted the push. */
  sendPush(fcmToken: string, title: string, body: string): Promise<boolean>;
}

export interface MessageSender {
  id: 'sms' | 'whatsapp' | 'telegram';
  sendMessage(to: string, body: string): Promise<{ ok: boolean; error?: string }>;
}

/** LinkTap cloud client seam. */
export interface LinkTapClient {
  /** Close the valve (activateInstantMode action:false). */
  shutoff(config: LinkTapCreds): Promise<void>;
  // The following are optional so existing test mocks (which only implement shutoff) still satisfy the
  // interface. LinkTapCloud implements all of them.
  /** Open the valve for a bounded duration (activateInstantMode action:true; no volume param). */
  open?(config: LinkTapCreds, opts?: InstantOpts): Promise<void>;
  /** Clear a latched LinkTap alarm (dismissAlarm). */
  dismissAlarm?(config: LinkTapCreds, alarm: AlarmCode): Promise<void>;
  /** Activate a pre-configured watering plan (used for "always open" so it survives a cloud outage). */
  activatePlan?(config: LinkTapCreds, mode: PlanMode): Promise<void>;
  /** Pause the active watering plan (travel mode). */
  pausePlan?(config: LinkTapCreds, opts: PauseOpts): Promise<void>;
}

/**
 * ntfy push seam — a FREE, self-host-friendly push channel (https://ntfy.sh or a self-hosted ntfy).
 * A vehicle configures a topic; the server POSTs alerts to it and users subscribe in the ntfy app.
 * Unlike FCM, this needs no Firebase project — it's the self-host "free push" path.
 */
export interface NtfyConfig {
  /** ntfy base URL (default https://ntfy.sh, or a self-hosted instance). */
  server: string;
  /** Topic to publish to (also what users subscribe to). Treat as a shared secret. */
  topic: string;
  /** Optional access token for a protected topic/instance. */
  token?: string;
}
export interface NtfyClient {
  /** Publish a notification. Returns true if ntfy accepted it. */
  send(config: NtfyConfig, title: string, body: string, priority?: 'high' | 'default'): Promise<boolean>;
}

export interface Deps {
  storage: Storage;
  notify: Notifier;
  messageSenders?: MessageSender[];
  linktap: LinkTapClient;
  /** Optional free push channel (ntfy). When set and a vehicle has an ntfy topic, alerts publish to it. */
  ntfy?: NtfyClient;
  /**
   * Deployment mode. `true` = the HOSTED multi-tenant worker: there is no single instance key, so the
   * instance-key gate is skipped and every webhook MUST carry a matching per-vehicle `&k=` secret
   * (strict SEC-4). `false`/unset = self-host: instance-key gate + phased SEC-4 (WEBHOOK_AUTH_REQUIRED).
   */
  multiTenant?: boolean;
  now: () => number;
  log?: (msg: string) => void;
}

export interface WebhookResult {
  status: 'ok' | 'unauthorized' | 'missing_vid' | 'vehicle_not_found';
  /** Per-vehicle webhook auth state (SEC-4): 'legacy' (no secret), 'ok', or 'unauthenticated'. */
  vehicleAuth?: 'legacy' | 'ok' | 'unauthenticated';
  event?: string;
  telemetry?: boolean;
  persisted?: boolean;
  notified?: number;
  pushFailed?: number;
  messagesSent?: number;
  messagesAttempted?: number;
  /** True if an ntfy notification was published for this alert. */
  ntfied?: boolean;
  shutoff?: ShutoffResult | null;
}
