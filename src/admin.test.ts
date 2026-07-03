import { describe, it, expect } from 'vitest';
import { handleAdminApi } from './admin.js';
import { MemoryStorage } from './storage.js';

// Capture the (status, body) a handler sends.
function capture() {
  const out: { status?: number; body?: any } = {};
  return { send: (status: number, body: unknown) => { out.status = status; out.body = body; }, out };
}
async function postVehicle(storage: MemoryStorage, body: any) {
  const c = capture();
  await handleAdminApi('/admin/api/vehicle', 'POST', JSON.stringify(body), storage, c.send);
  return c.out;
}

describe('handleAdminApi — vehicle registration', () => {
  it('stores the webhook secret + WhatsApp/Telegram prefs', async () => {
    const s = new MemoryStorage();
    const wa = JSON.stringify({ addresses: ['+15551112222'], events: ['flood'] });
    const tg = JSON.stringify({ addresses: ['@skipper'], events: ['flood'] });
    const res = await postVehicle(s, { vid: 'v1', allowedUsers: ['u1'], webhookSecret: 'sek', sh_whatsapp_prefs: wa, sh_telegram_prefs: tg });
    expect(res.status).toBe(200);
    const v = await s.getVehicle('v1');
    expect(v?.webhookSecret).toBe('sek');
    expect(v?.sh_whatsapp_prefs).toBe(wa);
    expect(v?.sh_telegram_prefs).toBe(tg);
  });

  it('preserves existing secret + prefs when a re-save omits them', async () => {
    const s = new MemoryStorage();
    await postVehicle(s, { vid: 'v1', allowedUsers: ['u1'], webhookSecret: 'sek', sh_whatsapp_prefs: '{"addresses":["+1"],"events":["flood"]}' });
    // Re-save with only a name change; the connector fields are omitted.
    const res = await postVehicle(s, { vid: 'v1', name: 'Renamed', allowedUsers: ['u1'] });
    expect(res.status).toBe(200);
    const v = await s.getVehicle('v1');
    expect(v?.name).toBe('Renamed');
    expect(v?.webhookSecret).toBe('sek');                  // not wiped
    expect(v?.sh_whatsapp_prefs).toContain('+1');          // not wiped
  });

  it('rejects a vehicle with no vid', async () => {
    const res = await postVehicle(new MemoryStorage(), { name: 'x' });
    expect(res.status).toBe(400);
  });
});
