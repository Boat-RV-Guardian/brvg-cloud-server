import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canMessageAlertForTier,
  parseMessagingPrefs,
  recipientsForEvent,
  noopMessageSender,
  twilioSmsSender,
  metaWhatsappSender,
  telegramSender,
} from './messaging.js';

describe('canMessageAlertForTier', () => {
  it('is premium-only', () => {
    expect(canMessageAlertForTier('premium')).toBe(true);
    expect(canMessageAlertForTier('basic')).toBe(false);
    expect(canMessageAlertForTier('free')).toBe(false);
    expect(canMessageAlertForTier(undefined)).toBe(false);
  });
});

describe('parseMessagingPrefs', () => {
  it('returns empty on null/garbage', () => {
    expect(parseMessagingPrefs(null)).toEqual({ addresses: [], events: [] });
    expect(parseMessagingPrefs('not json')).toEqual({ addresses: [], events: [] });
  });
  it('parses addresses + events, trimming and de-duping', () => {
    const p = parseMessagingPrefs(JSON.stringify({ addresses: [' +15551234567 ', '+15551234567', '@chat'], events: ['flood', 'flood', 'offline'] }));
    expect(p.addresses).toEqual(['+15551234567', '@chat']);
    expect(p.events).toEqual(['flood', 'offline']);
  });
  it('maps the legacy `phones` field to addresses', () => {
    const p = parseMessagingPrefs(JSON.stringify({ phones: ['+15550000000'], events: ['flood'] }));
    expect(p.addresses).toEqual(['+15550000000']);
  });
});

describe('recipientsForEvent', () => {
  const prefs = { addresses: ['+15551112222', '@tg'], events: ['flood', 'offline'] };
  it('returns nobody for a non-premium tier', () => {
    expect(recipientsForEvent('basic', prefs, 'flood')).toEqual([]);
    expect(recipientsForEvent('free', prefs, 'flood')).toEqual([]);
  });
  it('returns nobody for an event not opted into', () => {
    expect(recipientsForEvent('premium', prefs, 'low_battery')).toEqual([]);
  });
  it('returns the addresses for a premium vehicle + opted-in event', () => {
    expect(recipientsForEvent('premium', prefs, 'flood')).toEqual(['+15551112222', '@tg']);
  });
  it('is safe with null prefs', () => {
    expect(recipientsForEvent('premium', null, 'flood')).toEqual([]);
  });
});

// A fetch stub that records the last call and returns a canned response.
function stubFetch(status: number, body = '') {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
  });
  (globalThis as any).fetch = fn;
  return calls;
}
afterEach(() => { vi.restoreAllMocks(); (globalThis as any).fetch = undefined; });

describe('senders: not-configured fails closed (no network)', () => {
  it('each sender reports "not configured" when creds are missing, and carries its channel id', async () => {
    expect(noopMessageSender.id).toBe('sms');
    const sms = twilioSmsSender({});
    const wa = metaWhatsappSender({});
    const tg = telegramSender({});
    expect(sms.id).toBe('sms');
    expect(wa.id).toBe('whatsapp');
    expect(tg.id).toBe('telegram');
    expect((await sms.sendMessage('+1', 'hi')).error).toMatch(/twilio not configured/);
    expect((await wa.sendMessage('+1', 'hi')).error).toMatch(/whatsapp not configured/);
    expect((await tg.sendMessage('123', 'hi')).error).toMatch(/telegram not configured/);
  });
});

describe('twilioSmsSender request shape', () => {
  it('uses From for a plain number and MessagingServiceSid for an MG sid', async () => {
    let calls = stubFetch(201);
    await twilioSmsSender({ accountSid: 'AC1', authToken: 't', from: '+15550000000' }).sendMessage('+15551112222', 'hello');
    expect(calls[0].url).toContain('/Accounts/AC1/Messages.json');
    expect(calls[0].init.headers.Authorization).toMatch(/^Basic /);
    expect(String(calls[0].init.body)).toContain('From=');

    calls = stubFetch(201);
    await twilioSmsSender({ accountSid: 'AC1', authToken: 't', from: 'MGabc' }).sendMessage('+15551112222', 'hello');
    expect(String(calls[0].init.body)).toContain('MessagingServiceSid=MGabc');
  });
  it('surfaces a non-2xx as an error', async () => {
    stubFetch(400, 'bad');
    const r = await twilioSmsSender({ accountSid: 'AC1', authToken: 't', from: '+1' }).sendMessage('+1', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('twilio 400');
  });
});

describe('metaWhatsappSender request shape', () => {
  it('posts to the graph API and strips non-numerics from the destination', async () => {
    const calls = stubFetch(200);
    const r = await metaWhatsappSender({ phoneNumberId: 'PN1', accessToken: 'tok' }).sendMessage('+1 (555) 111-2222', 'hi');
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/PN1/messages');
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.messaging_product).toBe('whatsapp');
    expect(sent.to).toBe('15551112222');
  });
});

describe('telegramSender request shape', () => {
  it('posts to the bot API with the chat id as-is', async () => {
    const calls = stubFetch(200);
    const r = await telegramSender({ botToken: 'BOT:tok' }).sendMessage('@mychat', 'hi');
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/botBOT:tok/sendMessage');
    expect(JSON.parse(calls[0].init.body).chat_id).toBe('@mychat');
  });
});
