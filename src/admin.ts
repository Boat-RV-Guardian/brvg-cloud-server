// Minimal self-host instance admin: basic-auth gated. Lets the operator set the instance API key,
// the data-retention window, register vehicles (with LinkTap creds), and map user FCM tokens.
// Intentionally dependency-light (server-rendered HTML + small JSON endpoints).

import { safeEqual } from './auth.js';
import type { Storage, VehicleConfig } from './types.js';

/** Basic-auth check against ADMIN_PASSWORD (user is ignored). Denied if no password is configured. */
export function checkAdminAuth(header: string | undefined): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false; // force the operator to set ADMIN_PASSWORD before exposing /admin
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    return safeEqual(pass, pw); // constant-time
  } catch { return false; }
}

type Send = (status: number, body: unknown) => void;

export async function handleAdminApi(path: string, method: string, body: string, storage: Storage, send: Send): Promise<void> {
  const parse = () => { try { return JSON.parse(body || '{}'); } catch { return null; } };

  if (path === '/admin/api/status' && method === 'GET') {
    const vehicles = await storage.listVehicles();
    return send(200, {
      apiKeySet: !!(await storage.getSetting('apiKey')),
      allowUnauthenticated: (await storage.getSetting('allowUnauthenticated')) === 'true',
      retentionDays: Number(await storage.getSetting('retentionDays')) || null,
      vehicles: vehicles.map(v => ({ vid: v.vid, name: v.name, tier: v.tier, users: v.allowedUsers.length })),
    });
  }

  if (path === '/admin/api/settings' && method === 'POST') {
    const b = parse(); if (!b) return send(400, { error: 'bad json' });
    if (typeof b.apiKey === 'string') await storage.setSetting('apiKey', b.apiKey);
    if (b.allowUnauthenticated != null) await storage.setSetting('allowUnauthenticated', b.allowUnauthenticated ? 'true' : 'false');
    if (b.retentionDays != null) await storage.setSetting('retentionDays', String(Number(b.retentionDays)));
    return send(200, { ok: true });
  }

  if (path === '/admin/api/vehicle' && method === 'POST') {
    const b = parse(); if (!b?.vid) return send(400, { error: 'vid required' });
    // Preserve an existing webhookSecret unless one is explicitly provided (so re-saving a vehicle from
    // the admin form doesn't wipe its per-vehicle secret).
    const existing = await storage.getVehicle(String(b.vid));
    const v: VehicleConfig = {
      vid: String(b.vid),
      name: b.name ? String(b.name) : undefined,
      tier: ['free', 'basic', 'premium'].includes(b.tier) ? b.tier : undefined,
      allowedUsers: Array.isArray(b.allowedUsers) ? b.allowedUsers.map(String) : [],
      linktap: b.linktap || undefined,
      webhookSecret: typeof b.webhookSecret === 'string' && b.webhookSecret ? b.webhookSecret : existing?.webhookSecret,
      // Per-vehicle alert-destination prefs (JSON {addresses,events}); preserve existing when omitted so a
      // re-save from the form doesn't wipe them. SMS is hosted-only, so self-host only exposes WhatsApp + Telegram.
      sh_whatsapp_prefs: typeof b.sh_whatsapp_prefs === 'string' ? (b.sh_whatsapp_prefs || undefined) : existing?.sh_whatsapp_prefs,
      sh_telegram_prefs: typeof b.sh_telegram_prefs === 'string' ? (b.sh_telegram_prefs || undefined) : existing?.sh_telegram_prefs,
    };
    await storage.putVehicle(v);
    return send(200, { ok: true, vid: v.vid });
  }

  if (path === '/admin/api/user-token' && method === 'POST') {
    const b = parse(); if (!b?.uid || !b?.token) return send(400, { error: 'uid + token required' });
    await storage.putUserFcmToken(String(b.uid), String(b.token));
    return send(200, { ok: true });
  }

  send(404, { error: 'unknown admin endpoint' });
}

