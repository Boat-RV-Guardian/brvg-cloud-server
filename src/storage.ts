// Storage implementations. MemoryStorage for tests; FileStorage (a JSON file) for a zero-dependency
// self-host default. A SqliteStorage / D1Storage can be added later behind the same interface.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { downsampleHistory, RAW_HISTORY_WINDOW_DAYS } from './events.js';
import type { Storage, VehicleConfig, SensorState, HistorySample } from './types.js';

/** Hard cap on samples kept per device, regardless of retention window (memory/file-size guard). */
const MAX_HISTORY_SAMPLES = 5000;
const RAW_WINDOW_MS = RAW_HISTORY_WINDOW_DAYS * 86_400_000;

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
  async putSensorState(vid: string, device: string, state: SensorState) {
    this.db.sensorState[`${vid}/${device}`] = state;
    await this.persist();
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
    let seed: Partial<Db> | undefined;
    try {
      seed = JSON.parse(await readFile(path, 'utf8'));
    } catch { /* missing/corrupt → start fresh */ }
    return new FileStorage(path, seed);
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.db, null, 2));
  }
}
