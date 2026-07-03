import { describe, it, expect, vi, afterEach } from 'vitest';
import { ntfyClient, noopNtfy } from './ntfy.js';

function stubFetch(status: number) {
  const calls: Array<{ url: string; init: any }> = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status } as unknown as Response;
  });
  return calls;
}
afterEach(() => { vi.restoreAllMocks(); (globalThis as any).fetch = undefined; });

describe('ntfyClient', () => {
  it('POSTs the body to <server>/<topic> with an ASCII Title (emoji stripped)', async () => {
    const calls = stubFetch(200);
    const ok = await ntfyClient.send({ server: 'https://ntfy.sh', topic: 'brvg-boat' }, '🚨 Boaty', 'Flood detected', 'high');
    expect(ok).toBe(true);
    expect(calls[0].url).toBe('https://ntfy.sh/brvg-boat');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('Flood detected');
    expect(calls[0].init.headers.Title).toBe('Boaty');           // emoji + leading space stripped
    expect(calls[0].init.headers.Priority).toBe('high');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it('defaults the server to ntfy.sh and trims a trailing slash', async () => {
    const calls = stubFetch(200);
    await ntfyClient.send({ server: 'https://push.example.com/', topic: 't' }, 'x', 'y');
    expect(calls[0].url).toBe('https://push.example.com/t');
  });

  it('adds a bearer token for a protected topic', async () => {
    const calls = stubFetch(200);
    await ntfyClient.send({ server: 'https://ntfy.sh', topic: 't', token: 'tk_123' }, 'x', 'y');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tk_123');
  });

  it('returns false without a topic, and on a non-2xx / network error', async () => {
    expect(await ntfyClient.send({ server: 'https://ntfy.sh', topic: '' }, 'x', 'y')).toBe(false);
    stubFetch(500);
    expect(await ntfyClient.send({ server: 'https://ntfy.sh', topic: 't' }, 'x', 'y')).toBe(false);
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('down'); });
    expect(await ntfyClient.send({ server: 'https://ntfy.sh', topic: 't' }, 'x', 'y')).toBe(false);
  });

  it('noopNtfy never sends', async () => {
    expect(await noopNtfy.send({ server: 'https://ntfy.sh', topic: 't' }, 'x', 'y')).toBe(false);
  });
});
