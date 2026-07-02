// Transport-agnostic types shared by the core handler and its adapters.

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
  /** JSON string representing SmsPrefs */
  sh_sms_prefs?: string;
  /** JSON string representing WhatsappPrefs */
  sh_whatsapp_prefs?: string;
  /** JSON string representing TelegramPrefs */
  sh_telegram_prefs?: string;
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
  shutoff(config: {
    username: string;
    apiKey: string;
    gatewayId: string;
    taplinkerId: string;
  }): Promise<void>;
}

export interface Deps {
  storage: Storage;
  notify: Notifier;
  messageSenders?: MessageSender[];
  linktap: LinkTapClient;
  now: () => number;
  log?: (msg: string) => void;
}

export interface WebhookResult {
  status: 'ok' | 'unauthorized' | 'missing_vid' | 'vehicle_not_found';
  event?: string;
  telemetry?: boolean;
  persisted?: boolean;
  notified?: number;
  pushFailed?: number;
  messagesSent?: number;
  messagesAttempted?: number;
  shutoff?: ShutoffResult | null;
}
