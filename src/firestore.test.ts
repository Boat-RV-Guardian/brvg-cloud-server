import { describe, it, expect } from 'vitest';
import { vehicleFromFields } from './firestore.js';

// A Firestore REST `fields` object as the vehicle doc arrives (value-wrapped).
const s = (v: string) => ({ stringValue: v });

describe('vehicleFromFields', () => {
  it('reads the webhook secret + all messaging prefs (the fields the worker acts on)', () => {
    const v = vehicleFromFields('v1', {
      lt_vessel_name: s('Boaty'),
      tier: s('premium'),
      allowedUsers: { arrayValue: { values: [s('u1'), s('u2')] } },
      sh_webhook_secret: s('sekret'),
      sh_sms_prefs: s('{"phones":["+1"],"events":["flood"]}'),
      sh_whatsapp_prefs: s('{"addresses":["+2"],"events":["flood"]}'),
      sh_telegram_prefs: s('{"addresses":["@c"],"events":["offline"]}'),
      sh_ntfy_topic: s('brvg-boat'),
      sh_ntfy_server: s('https://push.test'),
    });
    expect(v.vid).toBe('v1');
    expect(v.name).toBe('Boaty');
    expect(v.tier).toBe('premium');
    expect(v.allowedUsers).toEqual(['u1', 'u2']);
    expect(v.webhookSecret).toBe('sekret');            // SEC-4 — was dropped before
    expect(v.sh_sms_prefs).toContain('flood');          // connectors — were dropped before
    expect(v.sh_whatsapp_prefs).toContain('+2');
    expect(v.sh_telegram_prefs).toContain('@c');
    expect(v.ntfyTopic).toBe('brvg-boat');              // ntfy free push
    expect(v.ntfyServer).toBe('https://push.test');
  });

  it('leaves the optional fields undefined when the doc omits them', () => {
    const v = vehicleFromFields('v2', { name: s('Rig'), allowedUsers: { arrayValue: { values: [] } } });
    expect(v.webhookSecret).toBeUndefined();
    expect(v.sh_sms_prefs).toBeUndefined();
    expect(v.sh_whatsapp_prefs).toBeUndefined();
    expect(v.sh_telegram_prefs).toBeUndefined();
    expect(v.tier).toBe('premium'); // legacy grandfather default
  });

  it('maps LinkTap creds + both taplinker ids', () => {
    const v = vehicleFromFields('v3', {
      allowedUsers: { arrayValue: { values: [s('u1')] } },
      lt_cloud_user: s('u'), lt_cloud_key: s('k'), lt_gateway_id: s('gw'),
      lt_device_id: s('t1'), lt_device_id_2: s('t2'),
    });
    expect(v.linktap?.taplinkerIds).toEqual(['t1', 't2']);
  });

  it('maps linktapAutoRecover from a boolean or "true" string, and leaves it undefined otherwise', () => {
    const base = { allowedUsers: { arrayValue: { values: [s('u1')] } } };
    expect(vehicleFromFields('v4', { ...base, lt_auto_recover: { booleanValue: true } }).linktapAutoRecover).toBe(true);
    expect(vehicleFromFields('v5', { ...base, lt_auto_recover: s('true') }).linktapAutoRecover).toBe(true);
    expect(vehicleFromFields('v6', { ...base }).linktapAutoRecover).toBeUndefined();
    expect(vehicleFromFields('v7', { ...base, lt_auto_recover: { booleanValue: false } }).linktapAutoRecover).toBeUndefined();
  });
});
