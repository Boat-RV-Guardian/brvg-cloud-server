// LinkTap cloud client — closes a valve via activateInstantMode (the call the app uses). Mirrors the
// worker; the old /api/turnOffV2 endpoint is dead (returns HTML 404), so do NOT use it.

import type { LinkTapClient } from './types.js';

export const LinkTapCloud: LinkTapClient = {
  async shutoff({ username, apiKey, gatewayId, taplinkerId }) {
    const res = await fetch('https://www.link-tap.com/api/activateInstantMode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, apiKey, gatewayId, taplinkerId, action: false, duration: 0, autoBack: true }),
    });
    if (!res.ok) throw new Error(`LinkTap API failure: ${await res.text()}`);
    const data: any = await res.json();
    if (data.result === 'error') throw new Error(`LinkTap API error: ${data.message}`);
  },
};
