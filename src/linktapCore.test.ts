import { describe, it, expect, beforeEach } from 'vitest';
import { handleLinkTapWebhook } from './linktapCore.js';
import { MemoryStorage } from './storage.js';
import type { Deps, LinkTapClient, Notifier, NtfyClient } from './types.js';

let pushCalls: { title: string; body: string }[];
let ntfyCalls: { topic: string; title: string; body: string }[];
let storage: MemoryStorage;
const nowMs = 1_000_000_000_000;

const linktap: LinkTapClient = { async shutoff() { /* unused here */ } };
const notify: Notifier = { async sendPush(_t, title, body) { pushCalls.push({ title, body }); return true; } };
const ntfy: NtfyClient = { async send(cfg, title, body) { ntfyCalls.push({ topic: cfg.topic, title, body }); return true; } };

function deps(over: Partial<Deps> = {}): Deps {
  return { storage, notify, linktap, ntfy, now: () => nowMs, log: () => {}, ...over };
}

const GW = '3C7A23FE004B1200';
const DEV = '68ABCDEF004B1200';

beforeEach(() => {
  pushCalls = []; ntfyCalls = [];
  storage = new MemoryStorage();
  storage.putVehicle({
    vid: 'v1', name: 'Boaty', tier: 'premium', allowedUsers: ['u1'],
    linktap: { username: 'u', apiKey: 'k', gatewayId: GW, taplinkerIds: [DEV] },
  });
  storage.putUserFcmToken('u1', 'tok1');
});

const body = (over: Record<string, unknown>) => ({ username: 'u', gatewayId: GW, deviceId: DEV, ...over });

describe('routing', () => {
  it('routes to the vehicle owning the gateway (case-insensitive) and persists state', async () => {
    const r = await handleLinkTapWebhook(body({ event: 'wateringOn', gatewayId: GW.toLowerCase() }), deps());
    expect(r.status).toBe('ok');
    expect(r.vid).toBe('v1');
    const state = await storage.getSensorState('v1', `linktap_${DEV}`);
    expect(state?.event).toBe('wateringOn');
    expect(state?.extra.watering).toBe('1');
  });

  it('returns vehicle_not_found for an unknown gateway', async () => {
    const r = await handleLinkTapWebhook(body({ event: 'wateringOn', gatewayId: 'FFFFFFFFFFFFFFFF' }), deps());
    expect(r.status).toBe('vehicle_not_found');
  });

  it('ignores an unparseable / nameless body', async () => {
    expect((await handleLinkTapWebhook(null, deps())).status).toBe('ignored');
    expect((await handleLinkTapWebhook(body({}), deps())).status).toBe('ignored');
  });
});

describe('alerts', () => {
  it('pushes on a real alarm (water cut-off) via FCM + ntfy', async () => {
    storage.putVehicle({
      vid: 'v1', name: 'Boaty', tier: 'premium', allowedUsers: ['u1'], ntfyTopic: 'boaty-alerts',
      linktap: { username: 'u', apiKey: 'k', gatewayId: GW, taplinkerIds: [DEV] },
    });
    const r = await handleLinkTapWebhook(body({ event: 'water cut-off alert', title: 'Cut-off', content: 'No water flow' }), deps());
    expect(r.notified).toBe(1);
    expect(pushCalls[0].body).toBe('No water flow');
    expect(ntfyCalls[0].topic).toBe('boaty-alerts');
    expect(r.ntfied).toBe(true);
  });

  it('does NOT push telemetry (flowMeterValue) but still caches it', async () => {
    const r = await handleLinkTapWebhook(body({ event: 'flowMeterValue', value: 3.4 }), deps());
    expect(r.notified).toBe(0);
    expect(pushCalls).toHaveLength(0);
    expect((await storage.getSensorState('v1', `linktap_${DEV}`))?.extra.flow).toBe('3.4');
  });

  it('does NOT push a watering-state change', async () => {
    const r = await handleLinkTapWebhook(body({ event: 'wateringOff', battery: 96 }), deps());
    expect(r.notified).toBe(0);
    expect((await storage.getSensorState('v1', `linktap_${DEV}`))?.extra.battery).toBe('96');
  });

  it('DEBOUNCES a gateway-offline flap: no push, but records the offline state', async () => {
    // Gateway connectivity events carry no deviceId → they land in linktap_unknown.
    const r = await handleLinkTapWebhook(body({ event: 'gateway offline', deviceId: '' }), deps());
    expect(r.notified).toBe(0); // the whole point — a flap doesn't buzz your phone
    expect(pushCalls).toHaveLength(0);
    const st = await storage.getSensorState('v1', 'linktap_unknown');
    expect(st?.extra.connState).toBe('offline');
    expect(st?.extra.offlineSince).toBe(String(nowMs));
  });

  it('gateway back online after an alerted outage sends ONE recovery notice', async () => {
    // Simulate the cron having alerted for this offline episode.
    await storage.putSensorState('v1', 'linktap_unknown',
      { event: 'gateway offline', at: nowMs, extra: { connState: 'offline', offlineSince: String(nowMs - 40 * 60_000), offlineAlerted: '1' } });
    const r = await handleLinkTapWebhook(body({ event: 'gateway online', deviceId: '' }), deps());
    expect(r.notified).toBe(1);
    expect(pushCalls[0].title).toContain('✅');
    expect(pushCalls[0].body).toMatch(/back online/i);
    const st = await storage.getSensorState('v1', 'linktap_unknown');
    expect(st?.extra.connState).toBe('online');
    expect(st?.extra.offlineAlerted).toBeUndefined();
  });

  it('gateway back online after a mere FLAP (never alerted) stays silent', async () => {
    await handleLinkTapWebhook(body({ event: 'gateway offline', deviceId: '' }), deps());
    const r = await handleLinkTapWebhook(body({ event: 'gateway online', deviceId: '' }), deps());
    expect(r.notified).toBe(0);
    expect(pushCalls).toHaveLength(0);
  });
});

describe('auto-recover (opt-in, benign only)', () => {
  let dismissed: { alarm: string }[];
  let opened: { durationMin?: number }[];
  const spyLinktap: LinkTapClient = {
    async shutoff() {},
    async dismissAlarm(_c, alarm) { dismissed.push({ alarm }); },
    async open(_c, opts) { opened.push({ durationMin: opts?.durationMin }); },
  };
  const withRecover = (on: boolean) => {
    storage.putVehicle({
      vid: 'v1', name: 'Boaty', tier: 'premium', allowedUsers: ['u1'], linktapAutoRecover: on,
      linktap: { username: 'u', apiKey: 'k', gatewayId: GW, taplinkerIds: [DEV] },
    });
  };
  beforeEach(() => { dismissed = []; opened = []; });

  it('is false by default (notify + leave closed) and never touches the valve', async () => {
    const r = await handleLinkTapWebhook(body({ event: 'water cut-off alert' }), deps({ linktap: spyLinktap }));
    expect(r.autoRecover).toBe(false);
    expect(r.recovered).toBe(false);
    expect(r.notified).toBe(1); // still notified
    expect(dismissed).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  it('clears + reopens a benign alarm (water cut-off) when opted in', async () => {
    withRecover(true);
    const r = await handleLinkTapWebhook(body({ event: 'water cut-off alert' }), deps({ linktap: spyLinktap }));
    expect(r.autoRecover).toBe(true);
    expect(r.recovered).toBe(true);
    expect(r.notified).toBe(1); // still notified even when auto-recovering
    expect(dismissed).toEqual([{ alarm: 'noWater' }]);
    expect(opened[0].durationMin).toBe(1439); // bounded reopen (autoBack resumes any plan)
  });

  it('also recovers unusually-low-flow', async () => {
    withRecover(true);
    const r = await handleLinkTapWebhook(body({ event: 'unusually low flow alert' }), deps({ linktap: spyLinktap }));
    expect(r.recovered).toBe(true);
    expect(dismissed).toEqual([{ alarm: 'pcFlag' }]);
  });

  it('NEVER auto-recovers high flow / valve broken / device fall / freeze even when opted in', async () => {
    withRecover(true);
    for (const event of ['unusually high flow alert', 'valve broken alert', 'device fall alert', 'freeze alert']) {
      const r = await handleLinkTapWebhook(body({ event }), deps({ linktap: spyLinktap }));
      expect(r.autoRecover, event).toBe(false);
      expect(r.recovered, event).toBe(false);
      expect(r.notified, event).toBe(1); // but still notified
    }
    expect(dismissed).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });
});
