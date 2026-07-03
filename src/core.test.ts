import { describe, it, expect, beforeEach } from 'vitest';
import { handleShellyWebhook, type ShellyWebhookInput } from './core.js';
import { MemoryStorage } from './storage.js';
import type { Deps, LinkTapClient, Notifier } from './types.js';

// Records of side effects for assertions.
let shutoffCalls: any[];
let pushCalls: { title: string; body: string }[];
let storage: MemoryStorage;
let nowMs: number;

const linktap: LinkTapClient = { async shutoff(cfg) { shutoffCalls.push(cfg); } };
const notify: Notifier = { async sendPush(_t, title, body) { pushCalls.push({ title, body }); return true; } };

function deps(): Deps { return { storage, notify, linktap, now: () => nowMs }; }

function input(over: Partial<ShellyWebhookInput> & { event: string }): ShellyWebhookInput {
  const sp = new URLSearchParams({ vid: 'v1', event: over.event, device: over.device || 'dev1', ...(over as any).extra });
  return { vid: over.vid ?? 'v1', event: over.event, device: over.device ?? 'dev1', params: sp, key: over.key ?? null, k: over.k ?? null };
}

beforeEach(() => {
  shutoffCalls = []; pushCalls = []; nowMs = 1_000_000_000_000;
  storage = new MemoryStorage();
  // Default the test instance to auth-disabled so the logic-focused tests aren't gated by the
  // fail-closed default; the auth describe block overrides this to exercise the gate.
  storage.setSetting('allowUnauthenticated', 'true');
  storage.putVehicle({
    vid: 'v1', name: 'Boaty', tier: 'premium', allowedUsers: ['u1'],
    linktap: { username: 'u', apiKey: 'k', gatewayId: 'gw', taplinkerIds: ['t1', 't2'] },
  });
  storage.putUserFcmToken('u1', 'tok1');
});

describe('flood shutoff safety', () => {
  it('closes every valve on a real flood.alarm and pushes', async () => {
    const r = await handleShellyWebhook(input({ event: 'flood.alarm' }), deps());
    expect(shutoffCalls).toHaveLength(2);
    expect(r.shutoff).toEqual({ ok: true, valves: 2 });
    expect(r.notified).toBe(1);
    expect(pushCalls[0].body).toContain('valve closed');
  });

  it('does NOT close the valve on flood.alarm_off (cleared)', async () => {
    const r = await handleShellyWebhook(input({ event: 'flood.alarm_off' }), deps());
    expect(shutoffCalls).toHaveLength(0);
    expect(r.shutoff).toBeNull();
    expect(r.notified).toBe(1); // still a (non-flood) alert push
  });

  it('reports partial failure if a valve close throws', async () => {
    const flaky: LinkTapClient = { async shutoff(cfg) { if (cfg.taplinkerId === 't2') throw new Error('rate limit'); shutoffCalls.push(cfg); } };
    const r = await handleShellyWebhook(input({ event: 'leak.detected' }), { ...deps(), linktap: flaky });
    expect(r.shutoff?.ok).toBe(true);
    expect(r.shutoff?.valves).toBe(1);
    expect(r.shutoff?.error).toContain('rate limit');
  });
});

describe('telemetry', () => {
  it('caches telemetry without pushing or shutting off', async () => {
    const r = await handleShellyWebhook(input({ event: 'voltmeter.measurement', extra: { v: '12.6' } } as any), deps());
    expect(r.telemetry).toBe(true);
    expect(r.notified).toBe(0);
    expect(shutoffCalls).toHaveLength(0);
    expect(r.persisted).toBe(true);
    expect((await storage.getSensorState('v1', 'dev1'))?.extra.v).toBe('12.6');
  });

  it('throttles telemetry persistence on lower tiers', async () => {
    storage.putVehicle({ vid: 'v1', tier: 'free', allowedUsers: ['u1'] }); // 30-min resolution
    const first = await handleShellyWebhook(input({ event: 'voltmeter.measurement' }), deps());
    expect(first.persisted).toBe(true);
    nowMs += 60_000; // 1 min later — within the 30-min window
    const second = await handleShellyWebhook(input({ event: 'voltmeter.measurement' }), deps());
    expect(second.persisted).toBe(false);
    nowMs += 1_800_000; // 30 min later — window elapsed
    const third = await handleShellyWebhook(input({ event: 'voltmeter.measurement' }), deps());
    expect(third.persisted).toBe(true);
  });
});

describe('history', () => {
  it('appends telemetry samples for paid tiers', async () => {
    await handleShellyWebhook(input({ event: 'voltmeter.measurement', extra: { v: '12.6' } } as any), deps());
    nowMs += 90_000;
    await handleShellyWebhook(input({ event: 'voltmeter.measurement', extra: { v: '12.4' } } as any), deps());
    const h = await storage.getHistory('v1', 'dev1');
    expect(h).toHaveLength(2);
    expect(h[0].extra.v).toBe('12.6');
    expect(h[1].extra.v).toBe('12.4');
  });

  it('keeps NO history for the free tier', async () => {
    storage.putVehicle({ vid: 'v1', tier: 'free', allowedUsers: ['u1'] });
    await handleShellyWebhook(input({ event: 'voltmeter.measurement', extra: { v: '12.6' } } as any), deps());
    expect(await storage.getHistory('v1', 'dev1')).toHaveLength(0);
  });

  it('does not append history for non-telemetry events', async () => {
    await handleShellyWebhook(input({ event: 'flood.alarm' }), deps());
    expect(await storage.getHistory('v1', 'dev1')).toHaveLength(0);
  });
});

describe('non-flood alerts', () => {
  it('pushes a plain sensor alert without shutoff', async () => {
    const r = await handleShellyWebhook(input({ event: 'button.push' }), deps());
    expect(shutoffCalls).toHaveLength(0);
    expect(r.notified).toBe(1);
    expect(pushCalls[0].body).toContain('button.push');
  });
});

describe('auth + validation', () => {
  it('FAILS CLOSED: a key-less instance rejects webhooks by default', async () => {
    storage.setSetting('allowUnauthenticated', 'false'); // no apiKey, not opted out
    const r = await handleShellyWebhook(input({ event: 'flood.alarm' }), deps());
    expect(r.status).toBe('unauthorized');
    expect(shutoffCalls).toHaveLength(0);
  });

  it('allows unauthenticated webhooks only when the operator explicitly opts out', async () => {
    // allowUnauthenticated=true is set in beforeEach; no apiKey configured.
    const r = await handleShellyWebhook(input({ event: 'flood.alarm' }), deps());
    expect(r.status).toBe('ok');
  });

  it('rejects a wrong API key when one is configured', async () => {
    await storage.setSetting('apiKey', 'secret');
    const r = await handleShellyWebhook(input({ event: 'flood.alarm', key: 'wrong' }), deps());
    expect(r.status).toBe('unauthorized');
    expect(shutoffCalls).toHaveLength(0);
  });

  it('accepts the correct API key', async () => {
    await storage.setSetting('apiKey', 'secret');
    const r = await handleShellyWebhook(input({ event: 'flood.alarm', key: 'secret' }), deps());
    expect(r.status).toBe('ok');
    expect(shutoffCalls).toHaveLength(2);
  });

  it('handles missing vid and unknown vehicle', async () => {
    expect((await handleShellyWebhook({ vid: null, event: 'x', device: 'd', params: [] }, deps())).status).toBe('missing_vid');
    expect((await handleShellyWebhook({ vid: 'nope', event: 'x', device: 'd', params: [] }, deps())).status).toBe('vehicle_not_found');
  });
});

describe('device limits', () => {
  it('rejects a new device if the tier limit is reached', async () => {
    // free tier allows 3 devices
    storage.putVehicle({
      vid: 'v2', name: 'Boaty Free', tier: 'free', allowedUsers: [],
      linktap: { taplinkerIds: ['t1'] } // 1 LinkTap device
    });
    // Add 2 shelly devices (total 3)
    await storage.putSensorState('v2', 'dev1', { event: 'online', at: 0, extra: {} });
    await storage.putSensorState('v2', 'dev2', { event: 'online', at: 0, extra: {} });
    
    // 4th device should be rejected
    const res = await handleShellyWebhook(input({ vid: 'v2', device: 'dev3', event: 'online' }), deps());
    expect(res.status).toBe('device_limit_reached');
    
    // Existing device should be accepted
    const res2 = await handleShellyWebhook(input({ vid: 'v2', device: 'dev1', event: 'online' }), deps());
    expect(res2.status).toBe('ok');
  });
});

describe('per-vehicle webhook auth (SEC-4, Phase 1)', () => {
  it('reports legacy for a vehicle with no webhookSecret (accepted, unchanged behavior)', async () => {
    const r = await handleShellyWebhook(input({ event: 'flood.alarm' }), deps());
    expect(r.status).toBe('ok');
    expect(r.vehicleAuth).toBe('legacy');
    expect(shutoffCalls).toHaveLength(2);
  });

  it('reports ok when the request carries the matching secret', async () => {
    storage.putVehicle({
      vid: 'v1', name: 'Boaty', tier: 'premium', allowedUsers: ['u1'], webhookSecret: 'sekret',
      linktap: { username: 'u', apiKey: 'k', gatewayId: 'gw', taplinkerIds: ['t1', 't2'] },
    });
    const r = await handleShellyWebhook(input({ event: 'flood.alarm', k: 'sekret' }), deps());
    expect(r.status).toBe('ok');
    expect(r.vehicleAuth).toBe('ok');
  });

  it('Phase 1: still processes an unauthenticated request but reports the state', async () => {
    storage.putVehicle({
      vid: 'v1', name: 'Boaty', tier: 'premium', allowedUsers: ['u1'], webhookSecret: 'sekret',
      linktap: { username: 'u', apiKey: 'k', gatewayId: 'gw', taplinkerIds: ['t1', 't2'] },
    });
    const r = await handleShellyWebhook(input({ event: 'flood.alarm', k: 'wrong' }), deps());
    expect(r.status).toBe('ok');               // Phase 1 accepts
    expect(r.vehicleAuth).toBe('unauthenticated');
    expect(shutoffCalls).toHaveLength(2);       // safety path still runs
  });

  it('never stores the secret `k` into sensorState', async () => {
    storage.putVehicle({ vid: 'v1', allowedUsers: ['u1'], webhookSecret: 'sekret' });
    await handleShellyWebhook(input({ event: 'voltmeter.measurement', k: 'sekret', extra: { v: '12.6' } } as any), deps());
    const st = await storage.getSensorState('v1', 'dev1');
    expect(st?.extra.k).toBeUndefined();
    expect(st?.extra.v).toBe('12.6');
  });
});

describe('ntfy free push', () => {
  function ntfyStub() {
    const sent: Array<{ config: any; title: string; body: string }> = [];
    return { sent, ntfy: { async send(config: any, title: string, body: string) { sent.push({ config, title, body }); return true; } } };
  }

  it('publishes to the vehicle ntfy topic on a real alert', async () => {
    storage.putVehicle({ vid: 'v1', name: 'Boaty', tier: 'premium', allowedUsers: ['u1'], ntfyTopic: 'brvg-boat', ntfyServer: 'https://push.test' });
    const { sent, ntfy } = ntfyStub();
    const r = await handleShellyWebhook(input({ event: 'flood.alarm' }), { ...deps(), ntfy });
    expect(r.ntfied).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].config).toEqual({ server: 'https://push.test', topic: 'brvg-boat', token: undefined });
    expect(sent[0].body).toContain('Flood');
  });

  it('does NOT publish when the vehicle has no ntfy topic', async () => {
    const { sent, ntfy } = ntfyStub();
    const r = await handleShellyWebhook(input({ event: 'flood.alarm' }), { ...deps(), ntfy });
    expect(r.ntfied).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('does NOT publish on telemetry (only real alerts)', async () => {
    storage.putVehicle({ vid: 'v1', allowedUsers: ['u1'], ntfyTopic: 'brvg-boat' });
    const { sent, ntfy } = ntfyStub();
    await handleShellyWebhook(input({ event: 'voltmeter.measurement' }), { ...deps(), ntfy });
    expect(sent).toHaveLength(0);
  });
});
