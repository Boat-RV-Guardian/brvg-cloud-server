import { describe, it, expect } from 'vitest';
import { SqlStorage, NodeSqliteDriver, createSqliteStorage } from './sql.js';
import { MAX_HISTORY_SAMPLES } from './storage.js';
import type { VehicleConfig } from './types.js';

async function fresh(): Promise<SqlStorage> {
  return createSqliteStorage(':memory:'); // schema-initialized, isolated per test
}

const vehicle = (vid: string): VehicleConfig => ({
  vid, name: 'Boaty', tier: 'premium', allowedUsers: ['u1', 'u2'],
  linktap: { username: 'lt', apiKey: 'k', gatewayId: 'g', taplinkerIds: ['t1'] },
});

describe('SqlStorage — vehicles', () => {
  it('round-trips a vehicle and lists/upserts it', async () => {
    const s = await fresh();
    expect(await s.getVehicle('v1')).toBeNull();
    await s.putVehicle(vehicle('v1'));
    expect(await s.getVehicle('v1')).toEqual(vehicle('v1'));
    expect(await s.listVehicles()).toHaveLength(1);
    // upsert (same id) replaces, doesn't duplicate
    await s.putVehicle({ ...vehicle('v1'), name: 'Renamed' });
    expect(await s.listVehicles()).toHaveLength(1);
    expect((await s.getVehicle('v1'))?.name).toBe('Renamed');
  });
});

describe('SqlStorage — sensorState', () => {
  it('upserts and reads the last-known state', async () => {
    const s = await fresh();
    expect(await s.getSensorState('v1', 'devA')).toBeNull();
    await s.putSensorState('v1', 'devA', { event: 'flood.alarm', at: 1000, extra: { v: '12.6' } });
    expect(await s.getSensorState('v1', 'devA')).toEqual({ event: 'flood.alarm', at: 1000, extra: { v: '12.6' } });
    await s.putSensorState('v1', 'devA', { event: 'flood.alarm_off', at: 2000, extra: {} });
    expect((await s.getSensorState('v1', 'devA'))?.event).toBe('flood.alarm_off');
    // distinct device keys don't collide
    expect(await s.getSensorState('v1', 'devB')).toBeNull();
  });
});

describe('SqlStorage — settings & tokens', () => {
  it('stores api key / settings and fcm tokens', async () => {
    const s = await fresh();
    expect(await s.getSetting('apiKey')).toBeNull();
    await s.setSetting('apiKey', 'secret');
    expect(await s.getSetting('apiKey')).toBe('secret');
    await s.setSetting('apiKey', 'rotated');
    expect(await s.getSetting('apiKey')).toBe('rotated');

    expect(await s.getUserFcmToken('u1')).toBeNull();
    await s.putUserFcmToken('u1', 'tok');
    expect(await s.getUserFcmToken('u1')).toBe('tok');
  });
});

describe('SqlStorage — history', () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const RETENTION = 90 * DAY;

  it('appends and reads oldest-first, with a since filter', async () => {
    const s = await fresh();
    await s.appendHistory('v1', 'd', { at: 1000, extra: { v: '1' } }, RETENTION);
    await s.appendHistory('v1', 'd', { at: 2000, extra: { v: '2' } }, RETENTION);
    const all = await s.getHistory('v1', 'd');
    expect(all.map((x) => x.at)).toEqual([1000, 2000]);
    expect(all[0].extra).toEqual({ v: '1' });
    expect((await s.getHistory('v1', 'd', 1500)).map((x) => x.at)).toEqual([2000]);
  });

  it('keeps nothing when retention is 0 (free tier)', async () => {
    const s = await fresh();
    await s.appendHistory('v1', 'd', { at: 1000, extra: {} }, 0);
    expect(await s.getHistory('v1', 'd')).toEqual([]);
  });

  it('drops samples older than the retention window', async () => {
    const s = await fresh();
    const now = 1_000 * DAY;
    await s.appendHistory('v1', 'd', { at: now - RETENTION - DAY, extra: { v: 'old' } }, RETENTION);
    await s.appendHistory('v1', 'd', { at: now, extra: { v: 'new' } }, RETENTION);
    const got = await s.getHistory('v1', 'd');
    expect(got.map((x) => x.extra.v)).toEqual(['new']); // the out-of-window sample was pruned
  });

  it('downsamples samples older than the raw window to ~hourly', async () => {
    const s = await fresh();
    const now = 100 * DAY;
    // Two samples within the same old hour (older than the 7-day raw window) collapse to one.
    await s.appendHistory('v1', 'd', { at: now - 30 * DAY, extra: { v: 'a' } }, RETENTION);
    await s.appendHistory('v1', 'd', { at: now - 30 * DAY + HOUR / 2, extra: { v: 'b' } }, RETENTION);
    await s.appendHistory('v1', 'd', { at: now, extra: { v: 'recent' } }, RETENTION);
    const got = await s.getHistory('v1', 'd');
    // recent (raw) kept; the two old same-hour samples downsampled to a single bucket.
    expect(got.length).toBeLessThan(3);
    expect(got.some((x) => x.extra.v === 'recent')).toBe(true);
  });

  it('enforces the hard sample cap', async () => {
    // appendHistory is a read-modify-write, so driving the cap through 5000+ public appends would be
    // O(n²) (and times out in CI). Seed the rows directly via the driver, then a SINGLE append must
    // exercise the cap path and trim back to MAX. All timestamps are recent (within the raw window)
    // so only the cap — not downsampling — does the trimming.
    const driver = new NodeSqliteDriver(':memory:');
    const s = new SqlStorage(driver);
    await s.init();
    const base = 1_000_000_000_000;
    for (let i = 0; i < MAX_HISTORY_SAMPLES; i++) {
      await driver.run('INSERT INTO history (vid, device, at, extra) VALUES (?, ?, ?, ?)',
        ['v1', 'd', base + i * 1000, JSON.stringify({ i: String(i) })]);
    }
    expect((await s.getHistory('v1', 'd')).length).toBe(MAX_HISTORY_SAMPLES);
    // One more append pushes to MAX+1, which the cap trims back to MAX (oldest dropped, newest kept).
    await s.appendHistory('v1', 'd', { at: base + MAX_HISTORY_SAMPLES * 1000, extra: { i: 'newest' } }, RETENTION);
    const got = await s.getHistory('v1', 'd');
    expect(got.length).toBe(MAX_HISTORY_SAMPLES);
    expect(got[got.length - 1].extra.i).toBe('newest');
    expect(got[0].extra.i).toBe('1'); // the original oldest (i=0) was dropped
    driver.close();
  });
});

describe('NodeSqliteDriver', () => {
  it('persists across two SqlStorage instances sharing one driver', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    const a = new SqlStorage(driver);
    await a.init();
    await a.putVehicle(vehicle('v9'));
    const b = new SqlStorage(driver); // same underlying db
    expect(await b.getVehicle('v9')).toEqual(vehicle('v9'));
    driver.close();
  });
});
