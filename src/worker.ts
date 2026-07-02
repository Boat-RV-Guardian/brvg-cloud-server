// Cloudflare Worker adapter (open-tasks Task 7 — "a Cloudflare adapter sharing this core, then unify
// with / retire the live worker"). Reuses the SAME injected core (handleShellyWebhook) + LinkTap/FCM
// clients as the Node server; only the transport (fetch handler) and storage (D1) differ. This is the
// path to retiring the duplicated logic in the standalone hosted worker (main repo worker/).
//
// Routes mirror server.ts: GET|POST /api/shelly, GET /api/history, GET /api/health (+ /healthz).
// Bindings (wrangler): D1 database `DB`; secrets FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY (FCM,
// optional — omit for no push). Globals fetch/Request/Response exist on the Workers runtime.

import { handleShellyWebhook } from './core.js';
import { SqlStorage } from './sql.js';
import { D1Driver, type D1Database } from './d1.js';
import { LinkTapCloud } from './linktap.js';
import { createFcmNotifier, NullNotifier } from './notify.js';
import { keyAuthorized } from './auth.js';
import type { Deps, Storage } from './types.js';

export interface Env {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function buildDeps(env: Env): { deps: Deps; storage: Storage } {
  const storage = new SqlStorage(new D1Driver(env.DB));
  const notify = env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY
    ? createFcmNotifier({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY,
      })
    : NullNotifier;
  return { deps: { storage, notify, linktap: LinkTapCloud, now: () => Date.now(), log: (m) => console.log(m) }, storage };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { deps, storage } = buildDeps(env);
      // Lazily ensure the schema exists (CREATE IF NOT EXISTS — cheap, idempotent).
      await (storage as SqlStorage).init();

      if (url.pathname === '/api/health' || url.pathname === '/healthz') {
        return json({ ok: true, service: 'brvg-cloud-server', time: Date.now() });
      }

      // Shelly webhooks — accept GET and POST (Shelly fires GET; never gate behind a method check).
      if (url.pathname === '/api/shelly') {
        const result = await handleShellyWebhook({
          vid: url.searchParams.get('vid'),
          event: url.searchParams.get('event') || 'sensor alert',
          device: url.searchParams.get('device'),
          params: url.searchParams,
          key: url.searchParams.get('key'),
        }, deps);
        const code = result.status === 'ok' ? 200
          : result.status === 'unauthorized' ? 401
          : result.status === 'vehicle_not_found' ? 404 : 400;
        return json(result, code);
      }

      // History read (charts/trends). Same API-key auth as webhooks.
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
};
