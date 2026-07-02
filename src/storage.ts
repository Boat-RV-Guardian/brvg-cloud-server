// Storage implementations. MemoryStorage for tests; FileStorage (a JSON file) for a zero-dependency
// self-host default. A SqliteStorage / D1Storage can be added later behind the same interface.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { downsampleHistory, RAW_HISTORY_WINDOW_DAYS } from './events.js';
import type { Storage, VehicleConfig, SensorState, HistorySample } from './types.js';

/** Hard cap on samples kept per device, regardless of retention window (memory/file-size guard). */
export const MAX_HISTORY_SAMPLES = 5000;
/**
 * Hard cap on distinct devices kept per vehicle (memory/file-size guard). MAX_HISTORY_SAMPLES bounds
 * samples *per* `vid/device` key, but nothing bounded the number of keys — a caller sending arbitrary
 * `device=` values for a registered vid could grow storage without limit. When a new device would
 * exceed the cap, that vehicle's least-recently-updated device (sensorState + history) is evicted.
 */
export const MAX_DEVICES_PER_VEHICLE = 64;
const RAW_WINDOW_MS = RAW_HISTORY_WINDOW_DAYS * 86_400_000;

/** The vid portion of a `${vid}/${device}` key. device is sanitized (no `/`), so split on the last `/`. */
function vidOfKey(key: string): string { return key.slice(0, key.lastIndexOf('/')); }

interface Db {
  vehicles: Record<string, VehicleConfig>;
  sensorState: Record<string, SensorState>; // key: `${vid}/${device}`
  history: Record<string, HistorySample[]>; // key: `${vid}/${device}`, oldest-first
  userTokens: Record<string, string>; // uid -> fcmToken
  settings: Record<string, string>;
}

const emptyDb = (): Db => ({ vehicles: {}, sensorState: {}, history: {}, userTokens: {}, settings: {} });

export class MemoryStorage implements Storage {
  protected db: Db;
  constructor(seed?: Partial<Db>) {
    this.db = { ...emptyDb(), ...seed } as Db;
  }
  async getVehicle(vid: string) { return this.db.vehicles[vid] ?? null; }
  async getSensorState(vid: string, device: string) { return this.db.sensorState[`${vid}/${device}`] ?? null; }
  async countSensorStates(vid: string) {
    return Object.keys(this.db.sensorState).filter(k => vidOfKey(k) === vid).length;
  }
  async putSensorState(vid: string, device: string, state: SensorState) {
    const key = `${vid}/${device}`;
    if (!(key in this.db.sensorState)) this.evictOldestDeviceIfOverCap(vid);
    this.db.sensorState[key] = state;
    await this.persist();
  }

  /**
   * If `vid` already has MAX_DEVICES_PER_VEHICLE distinct devices (about to add a new one), drop the
   * least-recently-updated device's sensorState + history so per-vehicle storage stays bounded.
   */
  private evictOldestDeviceIfOverCap(vid: string): void {
    const keys = Object.keys(this.db.sensorState).filter(k => vidOfKey(k) === vid);
    if (keys.length < MAX_DEVICES_PER_VEHICLE) return;
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const k of keys) {
      const at = this.db.sensorState[k]?.at ?? 0;
      if (at < oldestAt) { oldestAt = at; oldestKey = k; }
    }
    if (oldestKey) {
      delete this.db.sensorState[oldestKey];
      delete this.db.history[oldestKey];
    }
  }

  async appendHistory(vid: string, device: string, sample: HistorySample, retentionMs: number) {
    if (retentionMs <= 0) return; // tier keeps no history
    const key = `${vid}/${device}`;
    const cutoff = sample.at - retentionMs;
    let list = (this.db.history[key] ?? []).filter(s => s.at >= cutoff);
    list.push(sample);
    // Downsample older-than-raw-window samples to hourly so long-term history stays small.
    list = downsampleHistory(list, sample.at, RAW_WINDOW_MS);
    // Enforce the hard cap (keep the newest), then persist.
    this.db.history[key] = list.length > MAX_HISTORY_SAMPLES ? list.slice(list.length - MAX_HISTORY_SAMPLES) : list;
    await this.persist();
  }

  async getHistory(vid: string, device: string, sinceMs?: number) {
    const list = this.db.history[`${vid}/${device}`] ?? [];
    return sinceMs == null ? list.slice() : list.filter(s => s.at >= sinceMs);
  }
  async getUserFcmToken(uid: string) { return this.db.userTokens[uid] ?? null; }
  async getSetting(key: string) { return this.db.settings[key] ?? null; }
  async setSetting(key: string, value: string) { this.db.settings[key] = value; await this.persist(); }

  async listVehicles() { return Object.values(this.db.vehicles); }
  async putVehicle(v: VehicleConfig) { this.db.vehicles[v.vid] = v; await this.persist(); }
  async putUserFcmToken(uid: string, token: string) { this.db.userTokens[uid] = token; await this.persist(); }

  protected async persist(): Promise<void> { /* in-memory: no-op */ }
}

/** JSON-file-backed storage — survives restarts, no native deps. Good enough for small self-hosts. */
export class FileStorage extends MemoryStorage {
  constructor(private path: string, seed?: Partial<Db>) { super(seed); }

  static async load(path: string): Promise<FileStorage> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return new FileStorage(path); // missing file → normal first boot, start fresh
    }
    try {
      return new FileStorage(path, JSON.parse(raw));
    } catch {
      // Corrupt JSON: DON'T silently overwrite it with an empty DB (that would also wipe the apiKey
      // and drop the instance into an unconfigured/unauthenticated state). Preserve it for recovery.
      try { await rename(path, `${path}.corrupt`); } catch { /* best effort */ }
      return new FileStorage(path);
    }
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Atomic write: serialize to a temp file, then rename over the target. A crash/power-loss mid-write
    // leaves the previous good file intact instead of a truncated, unparseable one.
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.db, null, 2));
    await rename(tmp, this.path);
  }
}
