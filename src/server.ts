// Node HTTP adapter. Wires concrete deps (file storage, FCM/null notifier, LinkTap cloud) and routes:
//   GET|POST /api/shelly   — Shelly device webhooks (the same contract as the Cloudflare worker)
//   GET      /healthz       — liveness
//   /admin , /admin/api/*   — basic-auth instance admin (API key, vehicles, user tokens, data limits)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FileStorage } from './storage.js';
import { LinkTapCloud } from './linktap.js';
import { createFcmNotifier, NullNotifier } from './notify.js';
import { handleShellyWebhook } from './core.js';
import { renderAdminPage, handleAdminApi, checkAdminAuth } from './admin.js';
import { keyAuthorized } from './auth.js';
import type { Deps } from './types.js';

const PORT = Number(process.env.PORT || 3030);
const DB_PATH = process.env.DB_PATH || './data/brvg.json';

const storage = await FileStorage.load(DB_PATH);

const notify = process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
  ? createFcmNotifier({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY,
    })
  : NullNotifier;

const deps: Deps = { storage, notify, linktap: LinkTapCloud, now: () => Date.now(), log: (m) => console.log(m) };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') return json(res, 200, { ok: true });

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
      return json(res, code, result);
    }

    // History read (charts/trends). Same API-key auth as webhooks.
    if (url.pathname === '/api/history') {
      const requiredKey = await storage.getSetting('apiKey');
      const allowUnauth = (await storage.getSetting('allowUnauthenticated')) === 'true';
      if (!keyAuthorized(requiredKey, allowUnauth, url.searchParams.get('key'))) return json(res, 401, { status: 'unauthorized' });
      const vid = url.searchParams.get('vid');
      const device = url.searchParams.get('device');
      if (!vid || !device) return json(res, 400, { error: 'vid + device required' });
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam ? Number(sinceParam) : undefined;
      const samples = await storage.getHistory(vid, device, Number.isFinite(since) ? since : undefined);
      return json(res, 200, { vid, device, samples });
    }

    // Admin — basic auth on everything under /admin.
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (!checkAdminAuth(req.headers.authorization)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="brvg-admin"' });
        return res.end('Auth required');
      }
      if (url.pathname.startsWith('/admin/api/')) {
        const body = req.method === 'POST' ? await readBody(req) : '';
        return handleAdminApi(url.pathname, req.method || 'GET', body, storage, (s, b) => json(res, s, b));
      }
      const html = await renderAdminPage(storage);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    json(res, 404, { error: 'not found' });
  } catch (e: any) {
    json(res, 500, { error: e?.message || String(e) });
  }
});

server.listen(PORT, () => console.log(`brvg-cloud-server listening on :${PORT} (db=${DB_PATH})`));
