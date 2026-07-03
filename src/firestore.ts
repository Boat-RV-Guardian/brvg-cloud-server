import { SignJWT, importPKCS8 } from 'jose';
import type { Storage, VehicleConfig, SensorState, HistorySample, Tier } from './types.js';

const strField = (fields: any, key: string): string => fields?.[key]?.stringValue || '';
const arrField = (fields: any, key: string): string[] =>
  (fields?.[key]?.arrayValue?.values || []).map((v: any) => String(v.stringValue || v.integerValue || v.doubleValue)).filter(Boolean);
const numField = (fields: any, key: string): number | null => {
  const raw = fields?.[key]?.integerValue ?? fields?.[key]?.doubleValue;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
const mapField = (fields: any, key: string): Record<string, string> => {
  const map = fields?.[key]?.mapValue?.fields || {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries<any>(map)) out[k] = v.stringValue || '';
  return out;
};

/**
 * Build a VehicleConfig from a Firestore vehicle-doc `fields` object. Shared by getVehicle +
 * listVehicles so both pick up the same fields — crucially `webhookSecret` (SEC-4) and the messaging
 * prefs, which the app writes to the doc as `sh_webhook_secret` / `sh_sms_prefs` / `sh_whatsapp_prefs`
 * / `sh_telegram_prefs`. Without these the hosted worker can't verify per-vehicle webhook auth and
 * never resolves any SMS/WhatsApp/Telegram recipients.
 */
export function vehicleFromFields(vid: string, fields: any): VehicleConfig {
  const v: VehicleConfig = {
    vid,
    name: strField(fields, 'lt_vessel_name') || strField(fields, 'name'),
    tier: (strField(fields, 'tier') as Tier) || 'premium', // Legacy behavior: unset is grandfathered Premium
    allowedUsers: arrField(fields, 'allowedUsers'),
  };
  const ltUser = strField(fields, 'lt_cloud_user');
  if (ltUser) {
    v.linktap = {
      username: ltUser,
      apiKey: strField(fields, 'lt_cloud_key'),
      gatewayId: strField(fields, 'lt_gateway_id'),
      taplinkerIds: [strField(fields, 'lt_device_id'), strField(fields, 'lt_device_id_2')].filter(Boolean),
    };
  }
  const secret = strField(fields, 'sh_webhook_secret');
  if (secret) v.webhookSecret = secret;
  const sms = strField(fields, 'sh_sms_prefs');
  if (sms) v.sh_sms_prefs = sms;
  const whatsapp = strField(fields, 'sh_whatsapp_prefs');
  if (whatsapp) v.sh_whatsapp_prefs = whatsapp;
  const telegram = strField(fields, 'sh_telegram_prefs');
  if (telegram) v.sh_telegram_prefs = telegram;
  const ntfyTopic = strField(fields, 'sh_ntfy_topic');
  if (ntfyTopic) v.ntfyTopic = ntfyTopic;
  const ntfyServer = strField(fields, 'sh_ntfy_server');
  if (ntfyServer) v.ntfyServer = ntfyServer;
  const ntfyToken = strField(fields, 'sh_ntfy_token');
  if (ntfyToken) v.ntfyToken = ntfyToken;
  return v;
}

export interface FirestoreConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export class FirestoreStorage implements Storage {
  private projectId: string;
  private clientEmail: string;
  private privateKeyStr: string;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;
  
  // Settings cache to avoid hammering Firestore for static config
  private settingsCache = new Map<string, { value: string | null; at: number }>();

  constructor(config: FirestoreConfig) {
    this.projectId = config.projectId;
    this.clientEmail = config.clientEmail;
    this.privateKeyStr = config.privateKey.replace(/\\n/g, '\n');
  }

  public async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now) {
      return this.cachedToken.token;
    }

    const privateKey = await importPKCS8(this.privateKeyStr, 'RS256');
    const jwt = await new SignJWT({
      iss: this.clientEmail,
      sub: this.clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging'
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });

    if (!res.ok) throw new Error(`Failed to get OAuth token: ${await res.text()}`);
    const data: any = await res.json();
    this.cachedToken = { 
      token: data.access_token, 
      expiresAtMs: now + (data.expires_in - 60) * 1000 
    };
    return data.access_token;
  }

  public get docsBase() {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  public async getDoc(path: string): Promise<any | null> {
    const token = await this.getToken();
    const res = await fetch(`${this.docsBase}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.fields || null;
  }

  public async setDoc(path: string, fields: Record<string, any>): Promise<void> {
    const token = await this.getToken();
    const res = await fetch(`${this.docsBase}/${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`Firestore write failed: ${res.status} ${await res.text()}`);
  }

  public async patchDoc(path: string, fields: Record<string, any>, maskPaths: string[]): Promise<boolean> {
    const token = await this.getToken();
    const mask = maskPaths.map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join('&');
    const res = await fetch(`${this.docsBase}/${path}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) { console.warn(`Firestore patch failed (${path}): ${res.status} ${await res.text()}`); return false; }
    return true;
  }
  
  public async createDoc(collectionPath: string, id: string, fields: Record<string, any>): Promise<void> {
    const token = await this.getToken();
    const res = await fetch(`${this.docsBase}/${collectionPath}?documentId=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`Firestore create failed: ${res.status} ${await res.text()}`);
  }

  public async listCollection(collectionPath: string, maskFields?: string[]): Promise<Array<{ id: string; fields: any }>> {
    const token = await this.getToken();
    const out: Array<{ id: string; fields: any }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ pageSize: '300' });
      if (pageToken) params.set('pageToken', pageToken);
      for (const f of maskFields || []) params.append('mask.fieldPaths', f);
      const res = await fetch(`${this.docsBase}/${collectionPath}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { console.warn(`Firestore list failed (${collectionPath}): ${res.status}`); break; }
      const data: any = await res.json();
      for (const d of data.documents || []) {
        out.push({ id: String(d.name).split('/').pop() || '', fields: d.fields || {} });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return out;
  }

  // --- Storage implementation ---

  async getVehicle(vid: string): Promise<VehicleConfig | null> {
    const fields = await this.getDoc(`vehicles/${vid}`);
    if (!fields) return null;
    return vehicleFromFields(vid, fields);
  }

  async getSensorState(vid: string, device: string): Promise<SensorState | null> {
    const fields = await this.getDoc(`vehicles/${vid}/sensorState/${device}`);
    if (!fields) return null;
    const at = numField(fields, 'at');
    if (at == null) return null;
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries<any>(fields)) {
      if (k !== 'event' && k !== 'at' && k !== 'lastSend') {
        extra[k] = v.stringValue || String(v.integerValue || v.doubleValue || '');
      }
    }
    return { event: strField(fields, 'event'), at, extra };
  }

  public async putSensorState(vid: string, device: string, state: SensorState): Promise<void> {
    const fields: any = {
      event: { stringValue: state.event },
      at: { integerValue: String(state.at) }
    };
    for (const [k, v] of Object.entries(state.extra)) fields[k] = { stringValue: v };
    await this.setDoc(`vehicles/${vid}/sensorState/${device}`, fields);
  }

  public async countSensorStates(vid: string): Promise<number> {
    const docs = await this.listCollection(`vehicles/${vid}/sensorState`, ['event']);
    return docs.length;
  }

  async appendHistory(vid: string, device: string, sample: HistorySample, retentionMs: number): Promise<void> {
    // Hosted history uses monthly rollups: `vehicles/{vid}/history/{deviceId}_{YYYY-MM}`
    // But brvg-cloud-server expects appendHistory to abstract it.
    // For compatibility with brvg-cloud-server, we'll write to `vehicles/{vid}/history/{deviceId}_{timestamp}` or use monthly doc
    // Actually, in the unified version, we should just use the exact same schema.
    const date = new Date(sample.at);
    const yyyymm = date.toISOString().slice(0, 7); // "YYYY-MM"
    const docId = `${device}_${yyyymm}`;
    const key = String(sample.at);
    
    // Merge into the monthly map
    const fields: Record<string, any> = {
      month: { stringValue: yyyymm },
      device: { stringValue: device },
      events: { mapValue: { fields: {
        [key]: { mapValue: { fields: {} } }
      }}}
    };
    
    const eventFields: Record<string, any> = {};
    for (const [k, v] of Object.entries(sample.extra)) {
      eventFields[k] = { stringValue: String(v) };
    }
    fields.events.mapValue.fields[key].mapValue.fields = eventFields;

    const token = await this.getToken();
    // Using updateMask on map entries is possible, but merging might overwrite if not careful.
    // Standard patch without mask acts as a merge on map fields.
    const res = await fetch(`${this.docsBase}/vehicles/${vid}/history/${docId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) console.warn(`History append failed: ${res.status} ${await res.text()}`);
  }

  async getHistory(vid: string, device: string, sinceMs?: number): Promise<HistorySample[]> {
    // Only used for charts/trends in admin or paid tiers.
    // Scanning monthly docs is complex; this is a simplified read.
    const docs = await this.listCollection(`vehicles/${vid}/history`);
    const relevant = docs.filter(d => d.id.startsWith(device + '_'));
    const samples: HistorySample[] = [];
    
    for (const doc of relevant) {
      const eventsMap = doc.fields?.events?.mapValue?.fields || {};
      for (const [tsStr, mapVal] of Object.entries<any>(eventsMap)) {
        const at = Number(tsStr);
        if (Number.isNaN(at)) continue;
        if (sinceMs && at < sinceMs) continue;
        
        const extra: Record<string, string> = {};
        const inner = mapVal?.mapValue?.fields || {};
        for (const [k, v] of Object.entries<any>(inner)) {
          extra[k] = String(v.stringValue || v.integerValue || v.doubleValue || '');
        }
        samples.push({ at, extra });
      }
    }
    return samples.sort((a, b) => a.at - b.at);
  }

  async getUserFcmToken(uid: string): Promise<string | null> {
    const fields = await this.getDoc(`users/${uid}`);
    return fields ? strField(fields, 'fcmToken') : null;
  }

  async getSetting(key: string): Promise<string | null> {
    const hit = this.settingsCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const fields = await this.getDoc(`settings/${key}`);
    const val = fields ? strField(fields, 'value') : null;
    this.settingsCache.set(key, { value: val, at: Date.now() });
    return val;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.setDoc(`settings/${key}`, { value: { stringValue: value } });
    this.settingsCache.set(key, { value, at: Date.now() });
  }

  async listVehicles(): Promise<VehicleConfig[]> {
    const docs = await this.listCollection('vehicles');
    return docs.map(d => vehicleFromFields(d.id, d.fields));
  }

  async putVehicle(v: VehicleConfig): Promise<void> {
    const fields: Record<string, any> = {
      name: { stringValue: v.name || '' },
      tier: { stringValue: v.tier || 'premium' },
      allowedUsers: { arrayValue: { values: v.allowedUsers.map(u => ({ stringValue: u })) } }
    };
    if (v.linktap) {
      fields.lt_cloud_user = { stringValue: v.linktap.username || '' };
      fields.lt_cloud_key = { stringValue: v.linktap.apiKey || '' };
      fields.lt_gateway_id = { stringValue: v.linktap.gatewayId || '' };
      if (v.linktap.taplinkerIds && v.linktap.taplinkerIds.length > 0) {
        fields.lt_device_id = { stringValue: v.linktap.taplinkerIds[0] };
        if (v.linktap.taplinkerIds.length > 1) {
          fields.lt_device_id_2 = { stringValue: v.linktap.taplinkerIds[1] };
        }
      }
    }
    // Round-trip the webhook secret + messaging prefs when present (masked write, so absent fields are
    // left untouched rather than cleared).
    if (v.webhookSecret) fields.sh_webhook_secret = { stringValue: v.webhookSecret };
    if (v.sh_sms_prefs) fields.sh_sms_prefs = { stringValue: v.sh_sms_prefs };
    if (v.sh_whatsapp_prefs) fields.sh_whatsapp_prefs = { stringValue: v.sh_whatsapp_prefs };
    if (v.sh_telegram_prefs) fields.sh_telegram_prefs = { stringValue: v.sh_telegram_prefs };
    if (v.ntfyTopic) fields.sh_ntfy_topic = { stringValue: v.ntfyTopic };
    if (v.ntfyServer) fields.sh_ntfy_server = { stringValue: v.ntfyServer };
    if (v.ntfyToken) fields.sh_ntfy_token = { stringValue: v.ntfyToken };
    await this.patchDoc(`vehicles/${v.vid}`, fields, Object.keys(fields));
  }

  async putUserFcmToken(uid: string, token: string): Promise<void> {
    await this.patchDoc(`users/${uid}`, { fcmToken: { stringValue: token } }, ['fcmToken']);
  }
}
