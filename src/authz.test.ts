import { describe, it, expect } from 'vitest';
import { resolveRole, canControl, tierCanRemoteControl, validateControlCommand } from './authz.js';

describe('tierCanRemoteControl (Task 6 server-side)', () => {
  it('blocks the free tier', () => {
    expect(tierCanRemoteControl('free')).toBe(false);
  });

  it('allows basic and premium', () => {
    expect(tierCanRemoteControl('basic')).toBe(true);
    expect(tierCanRemoteControl('premium')).toBe(true);
  });

  it('grandfathers an unset/legacy tier (mirrors the premium read default)', () => {
    expect(tierCanRemoteControl(undefined)).toBe(true);
    expect(tierCanRemoteControl(null)).toBe(true);
    expect(tierCanRemoteControl('')).toBe(true);
  });
});

describe('resolveRole / canControl', () => {
  it('resolves an explicit member role', () => {
    expect(resolveRole({ u1: { role: 'monitor' } }, ['u1'], 'u1')).toBe('monitor');
  });

  it('backfills a legacy allowedUsers member as admin', () => {
    expect(resolveRole({}, ['u1'], 'u1')).toBe('admin');
  });

  it('returns null for a stranger, and null cannot control', () => {
    expect(resolveRole({}, ['u1'], 'u2')).toBeNull();
    expect(canControl(null)).toBe(false);
  });

  it('monitor cannot control; admin/control can', () => {
    expect(canControl('monitor')).toBe(false);
    expect(canControl('admin')).toBe(true);
    expect(canControl('control')).toBe(true);
  });
});

describe('validateControlCommand safety invariant', () => {
  it('close needs no limit', () => {
    expect(validateControlCommand({ action: 'close' }).ok).toBe(true);
  });

  it('open without a duration limit is rejected (valve must self-limit)', () => {
    expect(validateControlCommand({ action: 'open' }).ok).toBe(false);
    expect(validateControlCommand({ action: 'open', durationSec: 0 }).ok).toBe(false);
  });

  it('open normalizes to whole minutes capped at 1439', () => {
    const r = validateControlCommand({ action: 'open', durationSec: 90 });
    expect(r).toMatchObject({ ok: true, durationMins: 2 });
    expect(validateControlCommand({ action: 'open', durationSec: 10_000_000 }).durationMins).toBe(1439);
  });
});
