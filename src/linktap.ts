// LinkTap cloud client — the single place that talks to the LinkTap cloud API. Request shapes come
// from the pure builders in linktapCommands.ts (no `vol`; 1439-min cap; correct endpoints), so this
// file is just "POST the built body, throw on failure". The old /api/turnOffV2 endpoint is dead
// (HTML 404) — do NOT use it.

import type { LinkTapClient } from './types.js';
import {
  ENDPOINTS, instantModeBody, dismissAlarmBody, planBody, pauseBody, planEndpoint,
  type LinkTapCreds, type InstantOpts, type AlarmCode, type PlanMode, type PauseOpts,
} from './linktapCommands.js';

async function post(endpoint: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LinkTap API failure: ${await res.text()}`);
  const data: any = await res.json();
  if (data.result === 'error') throw new Error(`LinkTap API error: ${data.message}`);
}

export const LinkTapCloud: LinkTapClient = {
  async shutoff(config: LinkTapCreds) {
    await post(ENDPOINTS.instant, instantModeBody(config, false));
  },
  async open(config: LinkTapCreds, opts: InstantOpts = {}) {
    await post(ENDPOINTS.instant, instantModeBody(config, true, opts));
  },
  async dismissAlarm(config: LinkTapCreds, alarm: AlarmCode) {
    await post(ENDPOINTS.dismissAlarm, dismissAlarmBody(config, alarm));
  },
  async activatePlan(config: LinkTapCreds, mode: PlanMode) {
    await post(planEndpoint(mode), planBody(config));
  },
  async pausePlan(config: LinkTapCreds, opts: PauseOpts) {
    await post(ENDPOINTS.pause, pauseBody(config, opts));
  },
};
