// Pure, transport-agnostic parsing + classification of LinkTap webhook callbacks (setWebHookUrl).
//
// LinkTap posts a JSON envelope to our webhook for both "Events" (human-named, e.g. 'water cut-off
// alert') and "Messages" (camelCase, e.g. 'wateringOn', 'flowMeterValue'). This module normalizes
// either into one typed shape and classifies it (alarm / watering-state / telemetry / connectivity /
// battery / info), the same role events.ts plays for Shelly. No I/O here — routing to a vehicle,
// persistence, and alert dispatch live in the /api/linktap handler.
//
// Envelope (from the LinkTap API docs, V1.6):
//   { username, event, title, content, gatewayId, deviceId }         // Events
//   'watering start' additionally carries `workMode` (M/I/T/O/D/Y/N)
//   Messages reuse the same envelope; the name arrives in `event` (or `msg`/`message`), and
//   wateringOn/wateringOff/flowMeterValue may carry battery/signal/flow. The exact numeric fields
//   for the Message stream are under-specified in the docs, so extraction here is DEFENSIVE — we read
//   several likely field names and fall back to parsing `content`. Confirm shapes against the live
//   webhook (that's also the diagnostic that shows what's really happening to a valve).

export type LinkTapKind =
  | 'watering' // wateringOn/Off, watering start/end/skipped — valve state changes
  | 'alarm' // water cut-off / high-low flow / valve broken / device fall / freeze
  | 'alarmClear' // an alarm was cleared
  | 'battery' // battery low / good
  | 'connectivity' // gateway/device offline/online
  | 'telemetry' // flowMeterValue / flowMeterStatus — high-frequency, never push
  | 'info' // manual button pressed, etc.
  | 'unknown';

/** dismissAlarm codes (LinkTap `POST /api/dismissAlarm` `alarm` field). */
export type LinkTapAlarmCode = 'noWater' | 'valveBroken' | 'pbFlag' | 'pcFlag' | 'fallFlag';

export interface LinkTapWebhookBody {
  username?: string;
  event?: string;
  msg?: string;
  message?: string;
  title?: string;
  content?: string;
  gatewayId?: string;
  deviceId?: string;
  workMode?: string;
  battery?: number | string;
  signal?: number | string;
  vol?: number | string;
  value?: number | string;
  flow?: number | string;
  [k: string]: unknown;
}

export interface NormalizedLinkTapEvent {
  /** The raw LinkTap name, verbatim (e.g. 'water cut-off alert' or 'flowMeterValue'). */
  name: string;
  kind: LinkTapKind;
  gatewayId: string;
  deviceId: string;
  title: string;
  content: string;
  /** True when this should trigger a user-facing push (FCM/ntfy/SMS). Telemetry/state never push. */
  pushWorthy: boolean;
  /** For alarms that `dismissAlarm` can clear (freeze has no code). */
  alarmCode?: LinkTapAlarmCode;
  /** true = valve opened, false = valve closed, undefined = not a state event. */
  watering?: boolean;
  /** Activated watering mode, only on 'watering start'. */
  workMode?: string;
  battery?: number;
  signal?: number;
  /** Flow reading (units as LinkTap sends them) for flowMeterValue, when parseable. */
  flow?: number;
}

interface Classification {
  kind: LinkTapKind;
  pushWorthy: boolean;
  alarmCode?: LinkTapAlarmCode;
  watering?: boolean;
}

// Exact-match table for every documented Event + Message name. Anything unlisted → 'unknown'.
const TABLE: Record<string, Classification> = {
  // — Events —
  'watering start': { kind: 'watering', pushWorthy: false, watering: true },
  'watering end': { kind: 'watering', pushWorthy: false, watering: false },
  'watering cycle skipped': { kind: 'info', pushWorthy: true },
  'gateway offline': { kind: 'connectivity', pushWorthy: true },
  'gateway online': { kind: 'connectivity', pushWorthy: false },
  'device offline': { kind: 'connectivity', pushWorthy: true },
  'battery low alert': { kind: 'battery', pushWorthy: true },
  'battery good': { kind: 'battery', pushWorthy: false },
  'water cut-off alert': { kind: 'alarm', pushWorthy: true, alarmCode: 'noWater' },
  'unusually high flow alert': { kind: 'alarm', pushWorthy: true, alarmCode: 'pbFlag' },
  'unusually low flow alert': { kind: 'alarm', pushWorthy: true, alarmCode: 'pcFlag' },
  'valve broken alert': { kind: 'alarm', pushWorthy: true, alarmCode: 'valveBroken' },
  'device fall alert': { kind: 'alarm', pushWorthy: true, alarmCode: 'fallFlag' },
  'manual button pressed': { kind: 'info', pushWorthy: true },
  'freeze alert': { kind: 'alarm', pushWorthy: true }, // no dismissAlarm code for freeze
  'alarm clear': { kind: 'alarmClear', pushWorthy: false },
  // — Messages (camelCase) —
  wateringOn: { kind: 'watering', pushWorthy: false, watering: true },
  wateringOff: { kind: 'watering', pushWorthy: false, watering: false },
  flowMeterValue: { kind: 'telemetry', pushWorthy: false },
  flowMeterStatus: { kind: 'telemetry', pushWorthy: false },
  deviceOffline: { kind: 'connectivity', pushWorthy: true },
  deviceOnline: { kind: 'connectivity', pushWorthy: false },
  gatewayOffline: { kind: 'connectivity', pushWorthy: true },
  gatewayOnline: { kind: 'connectivity', pushWorthy: false },
};

/** Classify a LinkTap event/message name. Event names match case-insensitively; messages are exact. */
export function classifyLinkTapName(name: string): Classification {
  if (!name) return { kind: 'unknown', pushWorthy: false };
  const direct = TABLE[name];
  if (direct) return direct;
  const lowered = TABLE[name.trim().toLowerCase()];
  if (lowered) return lowered;
  return { kind: 'unknown', pushWorthy: false };
}

/** The dismissAlarm code for an alarm name, or null if it isn't a clearable alarm. */
export function linkTapAlarmCode(name: string): LinkTapAlarmCode | null {
  return classifyLinkTapName(name).alarmCode ?? null;
}

/**
 * Whether an alarm is safe to auto-clear + reopen for an always-on valve (opt-in per vehicle).
 * ONLY benign no-flow conditions: `noWater` (supply off / no draw) and `pcFlag` (unusually low flow).
 * NEVER `pbFlag` (unusually high flow — possible burst), `valveBroken`, or `fallFlag` — those are real
 * faults and must stay closed until a human acts. Freeze has no code and is likewise non-recoverable.
 */
export function isAutoRecoverableAlarm(code: LinkTapAlarmCode | null | undefined): boolean {
  return code === 'noWater' || code === 'pcFlag';
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a LinkTap webhook body into a typed event, or null if it carries no identifiable name.
 * The name is read from `event`, then `msg`/`message` (Messages sometimes arrive under those keys).
 */
export function parseLinkTapWebhook(body: LinkTapWebhookBody | null | undefined): NormalizedLinkTapEvent | null {
  if (!body || typeof body !== 'object') return null;
  const name = (body.event || body.msg || body.message || '').toString().trim();
  if (!name) return null;

  const c = classifyLinkTapName(name);
  const flow = c.kind === 'telemetry' ? num(body.flow ?? body.value ?? body.vol ?? body.content) : undefined;

  return {
    name,
    kind: c.kind,
    gatewayId: (body.gatewayId || '').toString(),
    deviceId: (body.deviceId || '').toString(),
    title: (body.title || '').toString(),
    content: (body.content || '').toString(),
    pushWorthy: c.pushWorthy,
    ...(c.alarmCode ? { alarmCode: c.alarmCode } : {}),
    ...(c.watering !== undefined ? { watering: c.watering } : {}),
    ...(body.workMode ? { workMode: String(body.workMode) } : {}),
    ...(num(body.battery) !== undefined ? { battery: num(body.battery) } : {}),
    ...(num(body.signal) !== undefined ? { signal: num(body.signal) } : {}),
    ...(flow !== undefined ? { flow } : {}),
  };
}
