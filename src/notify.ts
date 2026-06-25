// FCM HTTP v1 push sender. Authenticates with a Firebase service-account JSON (same project as the
// app). Self-hosters who don't want push can omit the credentials — NullNotifier is used instead.

import { SignJWT, importPKCS8 } from 'jose';
import type { Notifier } from './types.js';

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string; // PEM (\n or real newlines)
}

/** A notifier that does nothing (push disabled). */
export const NullNotifier: Notifier = {
  async sendPush() { return false; },
};

export function createFcmNotifier(cfg: FcmConfig): Notifier {
  let token: { value: string; exp: number } | null = null;

  async function accessToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (token && token.exp - 60 > nowSec) return token.value;
    const key = await importPKCS8(cfg.privateKey.replace(/\\n/g, '\n'), 'RS256');
    const jwt = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(cfg.clientEmail)
      .setSubject(cfg.clientEmail)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    if (!res.ok) throw new Error(`FCM token error: ${await res.text()}`);
    const data: any = await res.json();
    token = { value: data.access_token, exp: nowSec + Number(data.expires_in || 3600) };
    return token.value;
  }

  return {
    async sendPush(fcmToken, title, body) {
      try {
        const at = await accessToken();
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token: fcmToken, notification: { title, body } } }),
        });
        if (!res.ok) { console.warn(`FCM send failed: ${res.status} ${await res.text()}`); return false; }
        return true;
      } catch (e: any) {
        console.warn(`FCM send error: ${e?.message || e}`);
        return false;
      }
    },
  };
}
