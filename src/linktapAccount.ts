// Account-level LinkTap calls: register/unregister the event webhook, and fetch/rotate the API key.
// These take account creds (username + apiKey, or username + password for getApiKey) — not a valve id.
// Bodies come from the pure builders in linktapCommands.ts.

import {
  ENDPOINTS, setWebhookBody, deleteWebhookBody, getApiKeyBody, type LinkTapAccount,
} from './linktapCommands.js';

async function postForMessage(endpoint: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LinkTap API failure: ${await res.text()}`);
  const data: any = await res.json();
  if (data.result === 'error') throw new Error(`LinkTap API error: ${data.message}`);
  return String(data.message ?? '');
}

/** Register (or replace) the account's event webhook URL. LinkTap allows ONE URL per account. */
export async function linkTapSetWebhook(account: LinkTapAccount, webHookUrl: string): Promise<void> {
  await postForMessage(ENDPOINTS.setWebhook, setWebhookBody(account, webHookUrl));
}

/** Remove the account's event webhook (stop receiving events). */
export async function linkTapDeleteWebhook(account: LinkTapAccount): Promise<void> {
  await postForMessage(ENDPOINTS.deleteWebhook, deleteWebhookBody(account));
}

/**
 * Fetch (or rotate with `replace`) the account's API key. Returns the key (in the `message` field).
 * The password is sent for this one call only — DO NOT persist it; store only the returned key.
 */
export async function linkTapGetApiKey(username: string, password: string, replace = false): Promise<string> {
  return postForMessage(ENDPOINTS.getApiKey, getApiKeyBody(username, password, replace));
}
