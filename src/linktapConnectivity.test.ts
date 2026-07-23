import { describe, it, expect } from 'vitest';
import {
  isConnectivityOffline, onConnectivityEvent, shouldAlertSustainedOffline, offlineMinutes,
  GATEWAY_OFFLINE_GRACE_MS,
} from './linktapConnectivity.js';

const T0 = 1_800_000_000_000;

describe('isConnectivityOffline', () => {
  it('detects offline names (both Event and Message spellings), not online', () => {
    for (const n of ['gateway offline', 'device offline', 'gatewayOffline', 'deviceOffline']) {
      expect(isConnectivityOffline(n), n).toBe(true);
    }
    for (const n of ['gateway online', 'gatewayOnline', 'deviceOnline']) {
      expect(isConnectivityOffline(n), n).toBe(false);
    }
  });
});

describe('onConnectivityEvent', () => {
  it('an offline records the time and NEVER pushes now', () => {
    const r = onConnectivityEvent({}, 'gateway offline', T0);
    expect(r.push).toBe('none');
    expect(r.extra).toMatchObject({ connState: 'offline', offlineSince: String(T0) });
  });

  it('repeated offlines keep the ORIGINAL offline time (measures the whole episode)', () => {
    let e = onConnectivityEvent({}, 'gateway offline', T0).extra;
    e = onConnectivityEvent(e, 'gatewayOffline', T0 + 5 * 60_000).extra;
    expect(e.offlineSince).toBe(String(T0));
  });

  it('online after a FLAP (never alerted) clears silently — no push', () => {
    const off = onConnectivityEvent({}, 'gateway offline', T0).extra;
    const r = onConnectivityEvent(off, 'gateway online', T0 + 20_000);
    expect(r.push).toBe('none');
    expect(r.extra).toMatchObject({ connState: 'online' });
    expect(r.extra.offlineSince).toBeUndefined();
    expect(r.extra.offlineAlerted).toBeUndefined();
  });

  it('online AFTER a sustained-offline alert pushes a recovery notice and clears', () => {
    // Simulate the cron having marked the episode alerted.
    const alerted = { connState: 'offline', offlineSince: String(T0), offlineAlerted: '1' };
    const r = onConnectivityEvent(alerted, 'gateway online', T0 + GATEWAY_OFFLINE_GRACE_MS + 60_000);
    expect(r.push).toBe('recovered');
    expect(r.extra.connState).toBe('online');
    expect(r.extra.offlineAlerted).toBeUndefined();
  });

  it('preserves unrelated extras (battery/signal) while toggling connectivity', () => {
    const r = onConnectivityEvent({ battery: '100', signal: '3' }, 'gateway offline', T0);
    expect(r.extra).toMatchObject({ battery: '100', signal: '3', connState: 'offline' });
  });
});

describe('shouldAlertSustainedOffline (the cron gate)', () => {
  const off = onConnectivityEvent({}, 'gateway offline', T0).extra;

  it('is false before the grace window (a flap never reaches here)', () => {
    expect(shouldAlertSustainedOffline(off, T0 + GATEWAY_OFFLINE_GRACE_MS - 1)).toBe(false);
  });
  it('is true once offline past the grace window', () => {
    expect(shouldAlertSustainedOffline(off, T0 + GATEWAY_OFFLINE_GRACE_MS)).toBe(true);
    expect(shouldAlertSustainedOffline(off, T0 + 2 * GATEWAY_OFFLINE_GRACE_MS)).toBe(true);
  });
  it('is false once already alerted (so we alert exactly once per episode)', () => {
    expect(shouldAlertSustainedOffline({ ...off, offlineAlerted: '1' }, T0 + 10 * GATEWAY_OFFLINE_GRACE_MS)).toBe(false);
  });
  it('is false when online, missing, or malformed', () => {
    expect(shouldAlertSustainedOffline({ connState: 'online' }, T0 + 1e9)).toBe(false);
    expect(shouldAlertSustainedOffline(undefined, T0)).toBe(false);
    expect(shouldAlertSustainedOffline({ connState: 'offline' }, T0)).toBe(false); // no offlineSince
    expect(shouldAlertSustainedOffline({ connState: 'offline', offlineSince: 'nope' }, T0)).toBe(false);
  });

  it('the 30-minute default matches the owner decision', () => {
    expect(GATEWAY_OFFLINE_GRACE_MS).toBe(30 * 60 * 1000);
  });
});

describe('offlineMinutes', () => {
  it('reports whole minutes offline, 0 when unknown', () => {
    const off = onConnectivityEvent({}, 'gateway offline', T0).extra;
    expect(offlineMinutes(off, T0 + 31 * 60_000)).toBe(31);
    expect(offlineMinutes(undefined, T0)).toBe(0);
  });
});
