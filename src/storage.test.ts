import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, FileStorage, MAX_DEVICES_PER_VEHICLE } from './storage.js';

const DAY = 86_400_000;

describe('MemoryStorage history', () => {
  it('appends oldest-first and filters by since', async () => {
    const s = new MemoryStorage();
    await s.appendHistory('v', 'd', { at: 1000, extra: { v: '1' } }, 30 * DAY);
    await s.appendHistory('v', 'd', { at: 2000, extra: { v: '2' } }, 30 * DAY);
    expect((await s.getHistory('v', 'd')).map(x => x.extra.v)).toEqual(['1', '2']);
    expect((await s.getHistory('v', 'd', 1500)).map(x => x.extra.v)).toEqual(['2']);
  });

  it('prunes samples older than the retention window', async () => {
    const s = new MemoryStorage();
    const now = 100 * DAY;
    await s.appendHistory('v', 'd', { at: now - 40 * DAY, extra: { v: 'old' } }, 30 * DAY);
    await s.appendHistory('v', 'd', { at: now, extra: { v: 'new' } }, 30 * DAY); // prunes the 40-day-old one
    const h = await s.getHistory('v', 'd');
    expect(h).toHaveLength(1);
    expect(h[0].extra.v).toBe('new');
  });

  it('keeps nothing when retention is 0', async () => {
    const s = new MemoryStorage();
    await s.appendHistory('v', 'd', { at: 1000, extra: { v: '1' } }, 0);
    expect(await s.getHistory('v', 'd')).toHaveLength(0);
  });
});

describe('MemoryStorage device cap (SEC-11)', () => {
  it('caps distinct devices per vehicle, evicting the least-recently-updated', async () => {
    const s = new MemoryStorage();
    // Fill to the cap; device N has at=N so device 0 is the oldest.
    for (let i = 0; i < MAX_DEVICES_PER_VEHICLE; i++) {
      await s.putSensorState('v1', `d${i}`, { event: 'e', at: 100 + i, extra: {} });
    }
    await s.appendHistory('v1', 'd0', { at: 100, extra: { v: 'x' } }, 30 * DAY);
    // One more distinct device evicts the oldest (d0).
    await s.putSensorState('v1', 'dNEW', { event: 'e', at: 9999, extra: {} });
    expect(await s.getSensorState('v1', 'd0')).toBeNull();
    expect(await s.getHistory('v1', 'd0')).toHaveLength(0); // its history evicted too
    expect(await s.getSensorState('v1', 'dNEW')).not.toBeNull();
    expect(await s.getSensorState('v1', 'd1')).not.toBeNull();
  });

  it('re-updating an existing device does not count against the cap', async () => {
    const s = new MemoryStorage();
    for (let i = 0; i < MAX_DEVICES_PER_VEHICLE; i++) {
      await s.putSensorState('v1', `d${i}`, { event: 'e', at: 100 + i, extra: {} });
    }
    await s.putSensorState('v1', 'd0', { event: 'e', at: 500, extra: {} }); // update, not new
    expect(await s.getSensorState('v1', 'd0')).not.toBeNull();
    expect(Object.keys((s as any).db.sensorState).length).toBe(MAX_DEVICES_PER_VEHICLE);
  });
});

describe('FileStorage durability (SEC-3)', () => {
  it('preserves a corrupt db file instead of silently wiping it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brvg-'));
    const path = join(dir, 'brvg.json');
    await writeFile(path, '{ this is not valid json');
    const s = await FileStorage.load(path);
    // Corrupt original moved aside for recovery; a fresh empty db is used.
    await access(`${path}.corrupt`); // throws if missing
    expect(await s.getSetting('apiKey')).toBeNull();
  });

  it('round-trips settings/vehicles atomically across a reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brvg-'));
    const path = join(dir, 'brvg.json');
    const s = await FileStorage.load(path);
    await s.setSetting('apiKey', 'secret');
    await s.putVehicle({ vid: 'v1', allowedUsers: ['u1'] });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.settings.apiKey).toBe('secret');
    const reloaded = await FileStorage.load(path);
    expect(await reloaded.getSetting('apiKey')).toBe('secret');
    expect(await reloaded.getVehicle('v1')).not.toBeNull();
  });
});
