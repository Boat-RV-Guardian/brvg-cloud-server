import { describe, it, expect } from 'vitest';
import {
  instantModeBody, dismissAlarmBody, pauseBody, planEndpoint, isRateLimited,
  INSTANT_MODE_MAX_MIN, type LinkTapCreds,
} from './linktapCommands.js';

const c: LinkTapCreds = { username: 'u', apiKey: 'k', gatewayId: 'GW', taplinkerId: 'T1' };

describe('instantModeBody', () => {
  it('opens for a clamped duration and NEVER includes vol', () => {
    const b = instantModeBody(c, true, { durationMin: 30 });
    expect(b).toMatchObject({ username: 'u', apiKey: 'k', gatewayId: 'GW', taplinkerId: 'T1', action: true, duration: 30, autoBack: true });
    expect('vol' in b).toBe(false);
  });

  it('caps the open duration at 1439 and floors it at 1', () => {
    expect(instantModeBody(c, true, { durationMin: 99999 }).duration).toBe(INSTANT_MODE_MAX_MIN);
    expect(instantModeBody(c, true, { durationMin: 0 }).duration).toBe(1);
  });

  it('defaults the open duration to the 1439 max when unspecified', () => {
    expect(instantModeBody(c, true).duration).toBe(INSTANT_MODE_MAX_MIN);
  });

  it('closes with duration 0', () => {
    const b = instantModeBody(c, false);
    expect(b).toMatchObject({ action: false, duration: 0 });
    expect('vol' in b).toBe(false);
  });

  it('adds ECO fields only when both on/off are positive', () => {
    expect(instantModeBody(c, true, { durationMin: 20, ecoOnMin: 1, ecoOffMin: 2 })).toMatchObject({ eco: true, ecoOn: 1, ecoOff: 2 });
    expect('eco' in instantModeBody(c, true, { durationMin: 20, ecoOnMin: 0, ecoOffMin: 2 })).toBe(false);
  });

  it('honors an explicit autoBack=false', () => {
    expect(instantModeBody(c, true, { durationMin: 5, autoBack: false }).autoBack).toBe(false);
  });
});

describe('dismissAlarmBody', () => {
  it('carries the alarm code + creds', () => {
    expect(dismissAlarmBody(c, 'noWater')).toEqual({ username: 'u', apiKey: 'k', gatewayId: 'GW', taplinkerId: 'T1', alarm: 'noWater' });
  });
});

describe('pauseBody', () => {
  it('clamps a finite pause to 0.1–240 hours', () => {
    expect(pauseBody(c, { pauseHours: 5 }).pauseDuration).toBe(5);
    expect(pauseBody(c, { pauseHours: 1000 }).pauseDuration).toBe(240);
    expect(pauseBody(c, { pauseHours: 0 }).pauseDuration).toBe(0.1);
  });

  it('passes -1 through as an indefinite pause', () => {
    expect(pauseBody(c, { pauseHours: -1 }).pauseDuration).toBe(-1);
  });

  it('includes allDevice/overwrite only when set', () => {
    const b = pauseBody(c, { pauseHours: 2, allDevice: true, overwrite: 'ifTemporary' });
    expect(b).toMatchObject({ allDevice: true, overwrite: 'ifTemporary' });
    expect('allDevice' in pauseBody(c, { pauseHours: 2 })).toBe(false);
  });
});

describe('planEndpoint', () => {
  it('maps each plan mode to its activate endpoint', () => {
    expect(planEndpoint('interval')).toContain('/activateIntervalMode');
    expect(planEndpoint('oddEven')).toContain('/activateOddEvenMode');
    expect(planEndpoint('sevenDay')).toContain('/activateSevenDayMode');
    expect(planEndpoint('month')).toContain('/activateMonthMode');
    expect(planEndpoint('calendar')).toContain('/activateCalendarMode');
  });
});

describe('isRateLimited (15s min interval)', () => {
  it('blocks a second command inside 15s and allows it after', () => {
    expect(isRateLimited(1_000_000, 1_000_000 + 14_999)).toBe(true);
    expect(isRateLimited(1_000_000, 1_000_000 + 15_000)).toBe(false);
    expect(isRateLimited(null, 1_000_000)).toBe(false); // no prior command
  });
});
