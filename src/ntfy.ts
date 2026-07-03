// ntfy free-push client (https://ntfy.sh or a self-hosted ntfy). Publishing is a plain HTTP POST to
// `${server}/${topic}` — no Firebase, no account — which makes it the self-host "free push" path.
// Users install the ntfy app and subscribe to the topic. See docs / README.

import type { NtfyClient, NtfyConfig } from './types.js';

/** ntfy header values must be ASCII — strip non-ASCII (e.g. emoji) from the Title; the body keeps UTF-8. */
function asciiTitle(title: string): string {
  const t = title.replace(/[^\x20-\x7E]/g, '').trim();
  return t || 'Boat & RV Guardian'.replace(/[^\x20-\x7E]/g, '');
}

function normalizeServer(server: string | undefined): string {
  const s = (server || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  return s || 'https://ntfy.sh';
}

export const noopNtfy: NtfyClient = {
  async send() { return false; },
};

/** Real ntfy client (fetch-based; works on Node + the Workers runtime). */
export const ntfyClient: NtfyClient = {
  async send(config: NtfyConfig, title: string, body: string, priority = 'high'): Promise<boolean> {
    if (!config.topic) return false;
    const url = `${normalizeServer(config.server)}/${encodeURIComponent(config.topic)}`;
    const headers: Record<string, string> = {
      Title: asciiTitle(title),
      Priority: priority === 'high' ? 'high' : 'default',
      Tags: 'warning',
    };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      return res.ok;
    } catch {
      return false;
    }
  },
};
