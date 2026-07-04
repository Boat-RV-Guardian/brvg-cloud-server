import { describe, it, expect } from 'vitest';
import {
  classifyLinkTapName,
  linkTapAlarmCode,
  parseLinkTapWebhook,
  type LinkTapWebhookBody,
} from './linktapEvents.js';

describe('classifyLinkTapName', () => {
  it('classifies the flow/valve alarms as push-worthy with the right dismissAlarm code', () => {
    expect(classifyLinkTapName('water cut-off alert')).toMatchObject({ kind: 'alarm', pushWorthy: true, alarmCode: 'noWater' });
    expect(classifyLinkTapName('unusually high flow alert')).toMatchObject({ alarmCode: 'pbFlag' });
    expect(classifyLinkTapName('unusually low flow alert')).toMatchObject({ alarmCode: 'pcFlag' });
    expect(classifyLinkTapName('valve broken alert')).toMatchObject({ alarmCode: 'valveBroken' });
    expect(classifyLinkTapName('device fall alert')).toMatchObject({ alarmCode: 'fallFlag' });
  });

  it('treats freeze as a push-worthy alarm but with no dismiss code (LinkTap has none)', () => {
    const c = classifyLinkTapName('freeze alert');
    expect(c).toMatchObject({ kind: 'alarm', pushWorthy: true });
    expect(c.alarmCode).toBeUndefined();
  });

  it('never pushes telemetry (flowMeterValue/flowMeterStatus) or watering-state changes', () => {
    expect(classifyLinkTapName('flowMeterValue')).toMatchObject({ kind: 'telemetry', pushWorthy: false });
    expect(classifyLinkTapName('flowMeterStatus')).toMatchObject({ kind: 'telemetry', pushWorthy: false });
    expect(classifyLinkTapName('wateringOn')).toMatchObject({ kind: 'watering', pushWorthy: false, watering: true });
    expect(classifyLinkTapName('wateringOff')).toMatchObject({ kind: 'watering', pushWorthy: false, watering: false });
    expect(classifyLinkTapName('watering start')).toMatchObject({ watering: true, pushWorthy: false });
    expect(classifyLinkTapName('watering end')).toMatchObject({ watering: false, pushWorthy: false });
  });

  it('classifies connectivity: the *offline* directions push, *online* recoveries do not', () => {
    expect(classifyLinkTapName('gateway offline')).toMatchObject({ kind: 'connectivity', pushWorthy: true });
    expect(classifyLinkTapName('device offline')).toMatchObject({ pushWorthy: true });
    expect(classifyLinkTapName('gateway online')).toMatchObject({ pushWorthy: false });
    expect(classifyLinkTapName('deviceOnline')).toMatchObject({ pushWorthy: false });
  });

  it('battery low pushes, battery good does not', () => {
    expect(classifyLinkTapName('battery low alert')).toMatchObject({ kind: 'battery', pushWorthy: true });
    expect(classifyLinkTapName('battery good')).toMatchObject({ kind: 'battery', pushWorthy: false });
  });

  it('is case-insensitive for human Event names', () => {
    expect(classifyLinkTapName('WATER CUT-OFF ALERT')).toMatchObject({ alarmCode: 'noWater' });
    expect(classifyLinkTapName('  Valve Broken Alert  ')).toMatchObject({ alarmCode: 'valveBroken' });
  });

  it('returns unknown (never pushes) for anything unrecognized', () => {
    expect(classifyLinkTapName('some future event')).toEqual({ kind: 'unknown', pushWorthy: false });
    expect(classifyLinkTapName('')).toEqual({ kind: 'unknown', pushWorthy: false });
  });
});

describe('linkTapAlarmCode', () => {
  it('maps clearable alarms and returns null otherwise', () => {
    expect(linkTapAlarmCode('water cut-off alert')).toBe('noWater');
    expect(linkTapAlarmCode('freeze alert')).toBeNull(); // alarm, but no dismiss code
    expect(linkTapAlarmCode('wateringOn')).toBeNull();
  });
});

describe('parseLinkTapWebhook', () => {
  const base: LinkTapWebhookBody = {
    username: 'linktapuser',
    gatewayId: '3C7A23FE004B1200',
    deviceId: '68ABCDEF004B1200',
    title: 'Alert',
    content: 'something happened',
  };

  it('returns null when there is no event/message name', () => {
    expect(parseLinkTapWebhook({ ...base })).toBeNull();
    expect(parseLinkTapWebhook(null)).toBeNull();
    expect(parseLinkTapWebhook(undefined)).toBeNull();
  });

  it('normalizes a water cut-off alarm, carrying the dismiss code + gateway/device ids', () => {
    const n = parseLinkTapWebhook({ ...base, event: 'water cut-off alert' })!;
    expect(n).toMatchObject({
      name: 'water cut-off alert',
      kind: 'alarm',
      pushWorthy: true,
      alarmCode: 'noWater',
      gatewayId: '3C7A23FE004B1200',
      deviceId: '68ABCDEF004B1200',
    });
    expect(n.watering).toBeUndefined();
  });

  it("reads the name from `msg`/`message` too (Message stream)", () => {
    expect(parseLinkTapWebhook({ ...base, msg: 'wateringOn' })!.watering).toBe(true);
    expect(parseLinkTapWebhook({ ...base, message: 'wateringOff' })!.watering).toBe(false);
  });

  it("captures workMode on 'watering start'", () => {
    const n = parseLinkTapWebhook({ ...base, event: 'watering start', workMode: 'M' })!;
    expect(n).toMatchObject({ watering: true, workMode: 'M' });
  });

  it('extracts battery/signal on wateringOn/Off', () => {
    const n = parseLinkTapWebhook({ ...base, event: 'wateringOff', battery: 96, signal: '-44' })!;
    expect(n).toMatchObject({ battery: 96, signal: -44 });
  });

  it('reads flowMeterValue flow from `vel` (mL/min) as L/min — the real payload shape', () => {
    // Observed live: {"msg":"flowMeterValue", "vel":14520} → 14.52 L/min (≈ 3.8 gal/min).
    expect(parseLinkTapWebhook({ ...base, msg: 'flowMeterValue', vel: 14520 })!.flow).toBeCloseTo(14.52, 5);
    expect(parseLinkTapWebhook({ ...base, msg: 'flowMeterValue', vel: '5040' })!.flow).toBeCloseTo(5.04, 5);
  });

  it('falls back to value/content for flow when no `vel` is present', () => {
    expect(parseLinkTapWebhook({ ...base, event: 'flowMeterValue', value: 3.4 })!.flow).toBe(3.4);
    expect(parseLinkTapWebhook({ ...base, event: 'flowMeterValue', content: '4.15 GPM' })!.flow).toBe(4.15);
  });

  it('does not attach flow to non-telemetry events even if numeric fields are present', () => {
    const n = parseLinkTapWebhook({ ...base, event: 'water cut-off alert', value: 9 })!;
    expect(n.flow).toBeUndefined();
  });

  it('parses the real wateringOn payload (msg field, battery as a "100%" string)', () => {
    const n = parseLinkTapWebhook({ msg: 'wateringOn', gatewayId: 'GW', deviceId: 'DEV', battery: '100%', signal: 39, vel: 0, vol: 0 })!;
    expect(n).toMatchObject({ name: 'wateringOn', watering: true, battery: 100, signal: 39 });
  });
});
