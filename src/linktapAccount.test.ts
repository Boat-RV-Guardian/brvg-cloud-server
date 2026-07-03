import { describe, it, expect, vi, afterEach } from 'vitest';
import { linkTapSetWebhook, linkTapDeleteWebhook, linkTapGetApiKey } from './linktapAccount.js';

const okJson = (body: unknown) => ({ ok: true, async json() { return body; }, async text() { return ''; } }) as any;

afterEach(() => { vi.restoreAllMocks(); });

describe('linkTapSetWebhook', () => {
  it('POSTs the webhook body to setWebHookUrl', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ result: 'ok', message: 'success' }));
    await linkTapSetWebhook({ username: 'u', apiKey: 'k' }, 'https://x/api/linktap');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/setWebHookUrl');
    expect(JSON.parse((init as any).body)).toEqual({ username: 'u', apiKey: 'k', webHookUrl: 'https://x/api/linktap' });
  });

  it('throws on a LinkTap error result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ result: 'error', message: 'bad key' }));
    await expect(linkTapSetWebhook({ username: 'u', apiKey: 'k' }, 'https://x')).rejects.toThrow(/bad key/);
  });
});

describe('linkTapDeleteWebhook', () => {
  it('POSTs to deleteWebHookUrl', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ result: 'ok', message: 'success' }));
    await linkTapDeleteWebhook({ username: 'u', apiKey: 'k' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/deleteWebHookUrl');
  });
});

describe('linkTapGetApiKey', () => {
  it('returns the key from the message field and can request a rotation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ result: 'ok', message: 'THE_KEY' }));
    const key = await linkTapGetApiKey('u', 'pw', true);
    expect(key).toBe('THE_KEY');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({ username: 'u', password: 'pw', replace: true });
  });
});
