import { describe, it, expect } from 'vitest';
import {
  isFloodShutoff, isTelemetry, extractSensorStateExtras, sanitizeDevice,
  telemetryResolutionSecForTier, shouldPersistTelemetry,
  historyRetentionDaysForTier, downsampleHistory,
} from './events.js';

const DAY = 86_400_000; const HOUR = 3_600_000;

describe('isFloodShutoff', () => {
  it('fires on real flood/leak/alarm, not on cleared or telemetry', () => {
    expect(isFloodShutoff('flood.alarm')).toBe(true);
    expect(isFloodShutoff('leak.detected')).toBe(true);
    expect(isFloodShutoff('flood.alarm_off')).toBe(false);
    expect(isFloodShutoff('voltmeter.measurement')).toBe(false);
    expect(isFloodShutoff('button.push')).toBe(false);
  });
});

describe('extractSensorStateExtras', () => {
  it('keeps telemetry, drops routing/auth params + placeholders', () => {
    const sp = new URLSearchParams('vid=v1&event=e&device=d&key=secret&v=12.6&vraw=&tC=null&volts=11');
    expect(extractSensorStateExtras(sp)).toEqual({ v: '12.6', volts: '11' });
  });
});

describe('sanitizeDevice', () => {
  it('defaults and strips path chars', () => {
    expect(sanitizeDevice(null)).toBe('unknown');
    expect(sanitizeDevice('a/b#c')).toBe('a_b_c');
  });
});

describe('telemetry throttle helpers', () => {
  it('maps tiers and defaults unknown to premium', () => {
    expect(telemetryResolutionSecForTier('free')).toBe(1800);
    expect(telemetryResolutionSecForTier('basic')).toBe(300);
    expect(telemetryResolutionSecForTier(undefined)).toBe(60);
  });
  it('persists past the window, skips within it', () => {
    expect(shouldPersistTelemetry(1_000_000, null, 300)).toBe(true);
    expect(shouldPersistTelemetry(1_300_000, 1_000_000, 300)).toBe(true);
    expect(shouldPersistTelemetry(1_060_000, 1_000_000, 300)).toBe(false);
  });
});

describe('historyRetentionDaysForTier', () => {
  it('maps tiers; legacy→premium', () => {
    expect(historyRetentionDaysForTier('free')).toBe(0);
    expect(historyRetentionDaysForTier('basic')).toBe(30);
    expect(historyRetentionDaysForTier('premium')).toBe(1095);
    expect(historyRetentionDaysForTier(undefined)).toBe(1095);
  });
});

describe('downsampleHistory', () => {
  it('keeps recent samples raw, collapses old to one per hour', () => {
    const now = 100 * DAY;
    const samples = [
      { at: now - 30 * DAY, extra: { v: 'a' } },       // old, hour X
      { at: now - 30 * DAY + 5 * 60_000, extra: { v: 'b' } }, // old, SAME hour X → collapsed (b wins, latest)
      { at: now - 30 * DAY + HOUR + 1000, extra: { v: 'c' } }, // old, hour X+1
      { at: now - 60_000, extra: { v: 'd' } },         // recent (within 7d) → kept
      { at: now, extra: { v: 'e' } },                  // recent → kept
    ];
    const out = downsampleHistory(samples, now, 7 * DAY);
    expect(out.map(s => s.extra.v)).toEqual(['b', 'c', 'd', 'e']); // one per old hour + both recent
  });

  it('is a no-op when everything is within the raw window', () => {
    const now = 10 * DAY;
    const samples = [{ at: now - HOUR, extra: {} }, { at: now, extra: {} }];
    expect(downsampleHistory(samples, now, 7 * DAY)).toHaveLength(2);
  });
});

describe('isTelemetry', () => {
  it('matches measurement/change suffixes', () => {
    expect(isTelemetry('voltmeter.measurement')).toBe(true);
    expect(isTelemetry('temp.change')).toBe(true);
    expect(isTelemetry('flood.alarm')).toBe(false);
  });
});
