// Minimal self-host instance admin: basic-auth gated. Lets the operator set the instance API key,
// the data-retention window, register vehicles (with LinkTap creds), and map user FCM tokens.
// Intentionally dependency-light (server-rendered HTML + small JSON endpoints).

import type { Storage, VehicleConfig } from './types.js';

/** Basic-auth check against ADMIN_PASSWORD (user is ignored). Denied if no password is configured. */
export function checkAdminAuth(header: string | undefined): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false; // force the operator to set ADMIN_PASSWORD before exposing /admin
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    return pass === pw;
  } catch { return false; }
}

type Send = (status: number, body: unknown) => void;

export async function handleAdminApi(path: string, method: string, body: string, storage: Storage, send: Send): Promise<void> {
  const parse = () => { try { return JSON.parse(body || '{}'); } catch { return null; } };

  if (path === '/admin/api/status' && method === 'GET') {
    const vehicles = await storage.listVehicles();
    return send(200, {
      apiKeySet: !!(await storage.getSetting('apiKey')),
      retentionDays: Number(await storage.getSetting('retentionDays')) || null,
      vehicles: vehicles.map(v => ({ vid: v.vid, name: v.name, tier: v.tier, users: v.allowedUsers.length })),
    });
  }

  if (path === '/admin/api/settings' && method === 'POST') {
    const b = parse(); if (!b) return send(400, { error: 'bad json' });
    if (typeof b.apiKey === 'string') await storage.setSetting('apiKey', b.apiKey);
    if (b.retentionDays != null) await storage.setSetting('retentionDays', String(Number(b.retentionDays)));
    return send(200, { ok: true });
  }

  if (path === '/admin/api/vehicle' && method === 'POST') {
    const b = parse(); if (!b?.vid) return send(400, { error: 'vid required' });
    const v: VehicleConfig = {
      vid: String(b.vid),
      name: b.name ? String(b.name) : undefined,
      tier: ['free', 'basic', 'premium'].includes(b.tier) ? b.tier : undefined,
      allowedUsers: Array.isArray(b.allowedUsers) ? b.allowedUsers.map(String) : [],
      linktap: b.linktap || undefined,
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

export async function renderAdminPage(storage: Storage): Promise<string> {
  const vehicles = await storage.listVehicles();
  const apiKeySet = !!(await storage.getSetting('apiKey'));
  const retention = Number(await storage.getSetting('retentionDays')) || 0;
  const rows = vehicles.map(v => `<tr><td>${esc(v.vid)}</td><td>${esc(v.name || '')}</td><td>${esc(v.tier || '—')}</td><td>${v.allowedUsers.length}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>brvg-cloud-server admin</title>
<style>body{font-family:system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;background:#0b0f19;color:#e2e8f0}
h1{font-size:1.4rem}code{background:#1e293b;padding:2px 6px;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:.5rem 0}td,th{border:1px solid #334155;padding:6px 10px;text-align:left}
fieldset{border:1px solid #334155;border-radius:8px;margin:1rem 0}label{display:block;margin:.4rem 0 .1rem}
input,select{width:100%;padding:6px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px}
button{margin-top:.6rem;padding:8px 14px;background:#0ea5e9;color:#fff;border:0;border-radius:6px;cursor:pointer}</style></head>
<body><h1>🚤 brvg-cloud-server — admin</h1>
<p>Status: API key ${apiKeySet ? '✅ set' : '⚠️ not set'} · retention ${retention || '∞'} days · ${vehicles.length} vehicle(s)</p>
<table><thead><tr><th>Vehicle ID</th><th>Name</th><th>Tier</th><th>Users</th></tr></thead><tbody>${rows || '<tr><td colspan=4>none</td></tr>'}</tbody></table>
<fieldset><legend>Instance settings</legend>
<label>API key (devices must send <code>?key=…</code>)</label><input id=apiKey placeholder="leave blank to disable auth">
<label>Data retention (days, 0 = keep forever)</label><input id=retentionDays type=number value="${retention}">
<button onclick="save('/admin/api/settings',{apiKey:apiKey.value,retentionDays:retentionDays.value})">Save settings</button></fieldset>
<fieldset><legend>Add / update vehicle</legend>
<label>Vehicle ID</label><input id=vid><label>Name</label><input id=vname>
<label>Tier</label><select id=vtier><option value="">(unset)</option><option>free</option><option>basic</option><option>premium</option></select>
<label>Allowed user IDs (comma-separated)</label><input id=vusers>
<button onclick="save('/admin/api/vehicle',{vid:vid.value,name:vname.value,tier:vtier.value,allowedUsers:vusers.value.split(',').map(s=>s.trim()).filter(Boolean)})">Save vehicle</button></fieldset>
<fieldset><legend>Map user → FCM token</legend>
<label>User ID</label><input id=uid><label>FCM token</label><input id=utoken>
<button onclick="save('/admin/api/user-token',{uid:uid.value,token:utoken.value})">Save token</button></fieldset>
<script>async function save(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});alert(r.ok?'Saved':'Error: '+(await r.text()));if(r.ok)location.reload();}</script>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
