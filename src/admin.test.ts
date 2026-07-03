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
  it('stores the webhook secret', async () => {
    const s = new MemoryStorage();
    const res = await postVehicle(s, { vid: 'v1', allowedUsers: ['u1'], webhookSecret: 'sek' });
    expect(res.status).toBe(200);
    const v = await s.getVehicle('v1');
    expect(v?.webhookSecret).toBe('sek');
  });

  it('does NOT set third-party messaging destinations (hosted-cloud only)', async () => {
    const s = new MemoryStorage();
    await postVehicle(s, {
      vid: 'v1', allowedUsers: ['u1'],
      sh_whatsapp_prefs: '{"addresses":["+1"],"events":["flood"]}',
      sh_telegram_prefs: '{"addresses":["@x"],"events":["flood"]}',
    });
    const v = await s.getVehicle('v1');
    expect(v?.sh_whatsapp_prefs).toBeUndefined();
    expect(v?.sh_telegram_prefs).toBeUndefined();
  });

  it('preserves an existing webhook secret when a re-save omits it', async () => {
    const s = new MemoryStorage();
    await postVehicle(s, { vid: 'v1', allowedUsers: ['u1'], webhookSecret: 'sek' });
    const res = await postVehicle(s, { vid: 'v1', name: 'Renamed', allowedUsers: ['u1'] });
    expect(res.status).toBe(200);
    const v = await s.getVehicle('v1');
    expect(v?.name).toBe('Renamed');
    expect(v?.webhookSecret).toBe('sek'); // not wiped
  });

  it('stores the ntfy free-push topic/server/token and preserves them on an omitting re-save', async () => {
    const s = new MemoryStorage();
    await postVehicle(s, { vid: 'v1', allowedUsers: ['u1'], ntfyTopic: 'brvg-boat', ntfyServer: 'https://push.test', ntfyToken: 'tk' });
    let v = await s.getVehicle('v1');
    expect(v?.ntfyTopic).toBe('brvg-boat');
    expect(v?.ntfyServer).toBe('https://push.test');
    expect(v?.ntfyToken).toBe('tk');
    await postVehicle(s, { vid: 'v1', name: 'Renamed', allowedUsers: ['u1'] }); // omit ntfy fields
    v = await s.getVehicle('v1');
    expect(v?.ntfyTopic).toBe('brvg-boat'); // not wiped
  });

  it('rejects a vehicle with no vid', async () => {
    const res = await postVehicle(new MemoryStorage(), { name: 'x' });
    expect(res.status).toBe(400);
  });
});
