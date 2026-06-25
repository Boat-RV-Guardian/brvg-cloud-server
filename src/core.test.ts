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
  return { vid: over.vid ?? 'v1', event: over.event, device: over.device ?? 'dev1', params: sp, key: over.key ?? null };
}

beforeEach(() => {
  shutoffCalls = []; pushCalls = []; nowMs = 1_000_000_000_000;
  storage = new MemoryStorage();
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
