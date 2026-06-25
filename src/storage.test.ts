import { describe, it, expect } from 'vitest';
import { MemoryStorage } from './storage.js';

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
