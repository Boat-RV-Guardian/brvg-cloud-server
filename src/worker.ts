// Cloudflare Worker adapter (Task 7).

import { decodeProtectedHeader, importX509, jwtVerify } from 'jose';
import { handleShellyWebhook } from './core.js';
import { FirestoreStorage } from './firestore.js';
import { LinkTapCloud } from './linktap.js';
import { createFcmNotifier, NullNotifier } from './notify.js';
import { twilioSmsSender, metaWhatsappSender, telegramSender } from './messaging.js';
import { ntfyClient } from './ntfy.js';
import { keyAuthorized } from './auth.js';
import { resolveRole, canControl, validateControlCommand, type ControlAction } from './authz.js';
import { isTrialEligible, trialEndsAtFrom, isTrialExpired, historyRetentionDaysForTier, historyDocsToPrune } from './retention.js';
import type { Deps, Storage } from './types.js';

export interface Env {
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
  WHATSAPP_PHONE_ID?: string;
  WHATSAPP_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

async function verifyFirebaseIdToken(idToken: string, projectId: string): Promise<any> {
  const { kid } = decodeProtectedHeader(idToken);
  if (!kid) throw new Error('no kid');
  const certs: Record<string, string> = await fetch(FIREBASE_CERTS_URL).then((r) => r.json() as Promise<any>);
  const pem = certs[kid];
  if (!pem) throw new Error('unknown signing key');
  const key = await importX509(pem, 'RS256');
  const { payload } = await jwtVerify(idToken, key, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  return payload;
}

function buildDeps(env: Env): { deps: Deps; storage: FirestoreStorage } | null {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return null;
  const storage = new FirestoreStorage({
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    privateKey: env.FIREBASE_PRIVATE_KEY,
  });
  const notify = createFcmNotifier({
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    privateKey: env.FIREBASE_PRIVATE_KEY,
  });

  const messageSenders = [];
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    messageSenders.push(twilioSmsSender({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM }));
  }
  if (env.WHATSAPP_PHONE_ID && env.WHATSAPP_TOKEN) {
    messageSenders.push(metaWhatsappSender({ phoneNumberId: env.WHATSAPP_PHONE_ID, accessToken: env.WHATSAPP_TOKEN }));
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    messageSenders.push(telegramSender({ botToken: env.TELEGRAM_BOT_TOKEN }));
  }

  return { deps: { storage, notify, messageSenders, ntfy: ntfyClient, linktap: LinkTapCloud, now: () => Date.now(), log: (m) => console.log(m) }, storage };
}

async function triggerLinkTapInstant(config: any, action: ControlAction, durationMins: number, vol?: number): Promise<void> {
  const payload: any = {
    username: config.username,
    apiKey: config.apiKey,
    gatewayId: config.gatewayId,
    taplinkerId: config.taplinkerId,
    action: action === 'open',
    duration: action === 'open' ? durationMins : 0,
    autoBack: true,
  };
  if (action === 'open' && typeof vol === 'number' && vol > 0) payload.vol = vol;

  const res = await fetch('https://www.link-tap.com/api/activateInstantMode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`LinkTap API failure: ${await res.text()}`);
  const data: any = await res.json();
  if (data.result === 'error') throw new Error(`LinkTap API error: ${data.message}`);
}

async function handleControl(env: Env, request: Request, storage: FirestoreStorage): Promise<Response> {
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return json({ error: 'missing token' }, 401);
  let uid = '';
  try {
    const claims = await verifyFirebaseIdToken(m[1] || '', env.FIREBASE_PROJECT_ID || '');
    uid = String(claims.user_id || claims.sub || '');
  } catch (e: any) { return json({ error: 'invalid token: ' + (e?.message || e) }, 401); }
  if (!uid) return json({ error: 'token has no uid' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const vid = body?.vid;
  const action = body?.action as ControlAction;
  if (!vid) return json({ error: 'missing vid' }, 400);

  const vehicleDoc = await storage.getDoc(`vehicles/${vid}`);
  if (!vehicleDoc) return json({ error: 'vehicle not found' }, 404);

  const v = await storage.getVehicle(vid);
  if (!v) return json({ error: 'vehicle not found' }, 404);

  const membersMap = vehicleDoc.members?.mapValue?.fields || {};
  const members: Record<string, { role?: string }> = {};
  for (const [k, val] of Object.entries<any>(membersMap)) {
    members[k] = { role: val?.mapValue?.fields?.role?.stringValue };
  }

  const role = resolveRole(members, v.allowedUsers, uid);
  if (!canControl(role)) return json({ error: 'forbidden: role cannot control', role }, 403);

  const valRes = validateControlCommand({ action, durationSec: body?.durationSec, volumeLimitLiters: body?.volumeLimitLiters });
  if (!valRes.ok) return json({ error: valRes.error }, 400);

  const lt = v.linktap;
  if (!lt?.username || !lt?.apiKey || !lt?.gatewayId || !lt?.taplinkerIds?.length) {
    return json({ error: 'no LinkTap config' }, 400);
  }

  let ok = 0; let lastErr = '';
  for (const tap of lt.taplinkerIds) {
    try {
      await triggerLinkTapInstant({ username: lt.username, apiKey: lt.apiKey, gatewayId: lt.gatewayId, taplinkerId: tap }, action, valRes.durationMins || 0, valRes.vol);
      ok++;
    } catch (e: any) { lastErr = String(e?.message || e); }
  }
  return json(
    ok === lt.taplinkerIds.length ? { status: 'ok', action, valves: ok } : { status: 'partial', action, valves: ok, error: lastErr },
    ok > 0 ? 200 : 502,
  );
}

async function handleTrial(env: Env, request: Request, storage: FirestoreStorage, now = Date.now()): Promise<Response> {
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return json({ error: 'missing token' }, 401);
  let uid = '';
  try {
    const claims = await verifyFirebaseIdToken(m[1] || '', env.FIREBASE_PROJECT_ID || '');
    uid = String(claims.user_id || claims.sub || '');
  } catch (e: any) { return json({ error: 'invalid token: ' + (e?.message || e) }, 401); }
  if (!uid) return json({ error: 'token has no uid' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const vid = body?.vid;
  if (!vid) return json({ error: 'missing vid' }, 400);

  const vehicleDoc = await storage.getDoc(`vehicles/${vid}`);
  if (!vehicleDoc) return json({ error: 'vehicle not found' }, 404);

  const v = await storage.getVehicle(vid);
  if (!v) return json({ error: 'vehicle not found' }, 404);

  const membersMap = vehicleDoc.members?.mapValue?.fields || {};
  const members: Record<string, { role?: string }> = {};
  for (const [k, val] of Object.entries<any>(membersMap)) {
    members[k] = { role: val?.mapValue?.fields?.role?.stringValue };
  }
  const role = resolveRole(members, v.allowedUsers, uid);
  if (role !== 'admin') return json({ error: 'forbidden: only the vehicle owner can start a trial', role }, 403);

  const userDoc = await storage.getDoc(`users/${uid}`);
  const trialsUsed = (userDoc?.trialsUsed?.arrayValue?.values || []).map((x: any) => String(x.stringValue)).filter(Boolean);
  const vehicleTrialEndsAt = vehicleDoc.trialEndsAt?.integerValue ? Number(vehicleDoc.trialEndsAt.integerValue) : null;

  if (!isTrialEligible(vid, trialsUsed, vehicleTrialEndsAt)) {
    return json({ granted: false, reason: 'not eligible (already trialed this vehicle, or it has trialed before)' });
  }

  const trialEndsAt = trialEndsAtFrom(now);
  const vehicleOk = await storage.patchDoc(`vehicles/${vid}`, 
    { tier: { stringValue: 'basic' }, trialEndsAt: { integerValue: String(trialEndsAt) } }, 
    ['tier', 'trialEndsAt']
  );
  if (!vehicleOk) return json({ error: 'failed to write vehicle trial' }, 502);

  const nextTrialsUsed = [...trialsUsed, vid];
  await storage.patchDoc(`users/${uid}`, 
    { trialsUsed: { arrayValue: { values: nextTrialsUsed.map((x) => ({ stringValue: x })) } } }, 
    ['trialsUsed']
  );

  return json({ granted: true, tier: 'basic', trialEndsAt });
}

async function runDailyMaintenance(storage: FirestoreStorage, now = Date.now(), deleteCap = 500) {
  const vehicles = await storage.listCollection('vehicles', ['tier', 'trialEndsAt']);
  let trialsExpired = 0; let pruned = 0; let capped = false;

  for (const v of vehicles) {
    let tier = v.fields?.tier?.stringValue || '';
    const trialEndsAt = v.fields?.trialEndsAt?.integerValue ? Number(v.fields.trialEndsAt.integerValue) : null;
    
    if (isTrialExpired(trialEndsAt, now)) {
      const ok = await storage.patchDoc(`vehicles/${v.id}`, { tier: { stringValue: 'free' } }, ['tier', 'trialEndsAt']);
      if (ok) { tier = 'free'; trialsExpired++; }
    }

    if (capped) continue;
    const retentionDays = historyRetentionDaysForTier(tier);
    const hist = await storage.listCollection(`vehicles/${v.id}/history`, ['month']);
    const toDelete = historyDocsToPrune(hist.map((h) => h.id), retentionDays, now);
    for (const id of toDelete) {
      if (pruned >= deleteCap) { capped = true; break; }
      const token = await storage.getToken();
      const res = await fetch(`${storage.docsBase}/vehicles/${v.id}/history/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) pruned++;
    }
  }
  console.log(`maintenance: ${vehicles.length} vehicles, ${trialsExpired} trials expired, ${pruned} history docs pruned` + (capped ? ` (HIT delete cap ${deleteCap})` : ''));
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
      }

      const url = new URL(request.url);
      if (url.pathname === '/api/health' || url.pathname === '/healthz') {
        return json({ ok: true, service: 'brvg-cloud-server (hosted worker)', time: Date.now() });
      }

      const built = buildDeps(env);
      if (!built) return json({ error: 'missing firebase config' }, 500);
      const { deps, storage } = built;

      if (url.pathname === '/api/control' && request.method === 'POST') {
        return await handleControl(env, request, storage);
      }
      if (url.pathname === '/api/trial' && request.method === 'POST') {
        return await handleTrial(env, request, storage);
      }

      if (url.pathname === '/api/shelly') {
        const result = await handleShellyWebhook({
          vid: url.searchParams.get('vid'),
          event: url.searchParams.get('event') || 'sensor alert',
          device: url.searchParams.get('device'),
          params: url.searchParams,
          key: url.searchParams.get('key'),
          k: url.searchParams.get('k'),
        }, deps);
        const code = result.status === 'ok' ? 200 : result.status === 'unauthorized' ? 401 : result.status === 'vehicle_not_found' ? 404 : 400;
        return json(result, code);
      }

      if (url.pathname === '/api/history') {
        const requiredKey = await storage.getSetting('apiKey');
        const allowUnauth = (await storage.getSetting('allowUnauthenticated')) === 'true';
        if (!keyAuthorized(requiredKey, allowUnauth, url.searchParams.get('key'))) return json({ status: 'unauthorized' }, 401);
        const vid = url.searchParams.get('vid');
        const device = url.searchParams.get('device');
        if (!vid || !device) return json({ error: 'vid + device required' }, 400);
        const sinceParam = url.searchParams.get('since');
        const since = sinceParam ? Number(sinceParam) : undefined;
        const samples = await storage.getHistory(vid, device, Number.isFinite(since) ? since : undefined);
        return json({ vid, device, samples });
      }

      return json({ error: 'not found' }, 404);
    } catch (e: any) {
      return json({ error: e?.message || String(e) }, 500);
    }
  },

  async scheduled(_event: any, env: Env, ctx: ExecutionContext): Promise<void> {
    const built = buildDeps(env);
    if (!built) return;
    ctx.waitUntil(runDailyMaintenance(built.storage).catch((e) => console.error('maintenance failed:', e)));
  },
};
