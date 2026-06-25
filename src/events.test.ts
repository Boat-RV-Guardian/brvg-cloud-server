import { describe, it, expect } from 'vitest';
import {
  isFloodShutoff, isTelemetry, extractSensorStateExtras, sanitizeDevice,
  telemetryResolutionSecForTier, shouldPersistTelemetry,
} from './events.js';

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

describe('isTelemetry', () => {
  it('matches measurement/change suffixes', () => {
    expect(isTelemetry('voltmeter.measurement')).toBe(true);
    expect(isTelemetry('temp.change')).toBe(true);
    expect(isTelemetry('flood.alarm')).toBe(false);
  });
});
