import type { MessageSender } from './types.js';

/** Premium-only messaging escalation. */
export function canMessageAlertForTier(tier: string | null | undefined): boolean {
  return tier === 'premium';
}

export interface MessagingPrefs {
  /** Destination addresses (phone numbers or chat IDs). */
  addresses: string[];
  /** Event keys the user has opted into (e.g. 'flood', 'offline', 'low_battery'). */
  events: string[];
}

export function parseMessagingPrefs(raw: string | null | undefined): MessagingPrefs {
  if (!raw) return { addresses: [], events: [] };
  try {
    const o = JSON.parse(raw) as { phones?: unknown; addresses?: unknown; events?: unknown };
    // Map legacy `phones` or new `addresses`
    const rawAddrs = Array.isArray(o.addresses) ? o.addresses : (Array.isArray(o.phones) ? o.phones : []);
    const addresses = rawAddrs.map((p) => String(p).trim()).filter((s) => s.length > 0);
    const events = Array.isArray(o.events) ? o.events.map((e) => String(e)).filter((s) => s.length > 0) : [];
    return { addresses: [...new Set(addresses)], events: [...new Set(events)] };
  } catch {
    return { addresses: [], events: [] };
  }
}

export function recipientsForEvent(
  tier: string | null | undefined,
  prefs: MessagingPrefs | null | undefined,
  event: string,
): string[] {
  if (!canMessageAlertForTier(tier)) return [];
  if (!event || !prefs || !prefs.events.includes(event)) return [];
  return [...new Set(prefs.addresses.map((p) => String(p).trim()).filter(Boolean))];
}

export const noopMessageSender: MessageSender = {
  id: 'sms',
  async sendMessage(to: string, _body: string) {
    console.log(`[noop] no provider configured — would send to ${to}`);
    return { ok: false, error: 'no provider configured' };
  },
};

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  from?: string;
}

export function twilioSmsSender(cfg: TwilioConfig): MessageSender {
  return {
    id: 'sms',
    async sendMessage(to: string, body: string) {
      const { accountSid, authToken, from } = cfg;
      if (!accountSid || !authToken || !from) return { ok: false, error: 'twilio not configured' };
      const params = new URLSearchParams({ To: to, Body: body });
      if (from.startsWith('MG')) params.set('MessagingServiceSid', from);
      else params.set('From', from);
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });
        if (!res.ok) return { ok: false, error: `twilio ${res.status}: ${(await res.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
  };
}

export interface MetaWhatsappConfig {
  phoneNumberId?: string;
  accessToken?: string;
}

export function metaWhatsappSender(cfg: MetaWhatsappConfig): MessageSender {
  return {
    id: 'whatsapp',
    async sendMessage(to: string, body: string) {
      const { phoneNumberId, accessToken } = cfg;
      if (!phoneNumberId || !accessToken) return { ok: false, error: 'whatsapp not configured' };
      try {
        const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: to.replace(/[^0-9]/g, ''), // Strip non-numeric for WhatsApp E.164
            type: 'text',
            text: { body }
          }),
        });
        if (!res.ok) return { ok: false, error: `whatsapp ${res.status}: ${(await res.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    }
  }
}

export interface TelegramConfig {
  botToken?: string;
}

export function telegramSender(cfg: TelegramConfig): MessageSender {
  return {
    id: 'telegram',
    async sendMessage(to: string, body: string) {
      const { botToken } = cfg;
      if (!botToken) return { ok: false, error: 'telegram not configured' };
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ chat_id: to, text: body }),
        });
        if (!res.ok) return { ok: false, error: `telegram ${res.status}: ${(await res.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    }
  }
}
