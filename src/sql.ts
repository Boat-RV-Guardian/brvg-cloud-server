// SQL-backed Storage (open-tasks Task 7 increment 4). One implementation, two drivers:
//   - NodeSqliteDriver  → `node:sqlite` (Node 22+, zero native dep) for a durable self-host store.
//   - D1Driver          → Cloudflare D1 (see d1.ts) for the hosted Cloudflare adapter (worker.ts).
//
// The `SqlDriver` seam is a tiny async query interface both runtimes satisfy, so `SqlStorage` (and its
// schema + queries) is shared and unit-tested once against in-memory SQLite — see sql.test.ts. Values
// are stored as JSON blobs keyed by id (a KV-over-SQL shape), which ports cleanly between SQLite and
// D1 and matches the Storage interface's document-ish model.

import { DatabaseSync } from 'node:sqlite';
import { downsampleHistory, RAW_HISTORY_WINDOW_DAYS } from './events.js';
import { MAX_HISTORY_SAMPLES } from './storage.js';
import type { Storage, VehicleConfig, SensorState, HistorySample } from './types.js';

const RAW_WINDOW_MS = RAW_HISTORY_WINDOW_DAYS * 86_400_000;

/**
 * Minimal async SQL interface. node:sqlite is synchronous and D1 is async; both are adapted to this
 * Promise-returning shape so SqlStorage can be written once. `exec` runs schema (no params);
 * run/all/get are parameterized with `?` placeholders.
 */
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vehicles (vid TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sensor_state (vid TEXT NOT NULL, device TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (vid, device));
CREATE TABLE IF NOT EXISTS history (vid TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL, extra TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_key_at ON history (vid, device, at);
CREATE TABLE IF NOT EXISTS user_tokens (uid TEXT PRIMARY KEY, token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Storage backed by any SqlDriver. Call `init()` once (creates the schema) before use. */
export class SqlStorage implements Storage {
  constructor(private readonly db: SqlDriver) {}

  async init(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  async getVehicle(vid: string): Promise<VehicleConfig | null> {
    const row = await this.db.get<{ json: string }>('SELECT json FROM vehicles WHERE vid = ?', [vid]);
    return row ? (JSON.parse(row.json) as VehicleConfig) : null;
  }

  async listVehicles(): Promise<VehicleConfig[]> {
    const rows = await this.db.all<{ json: string }>('SELECT json FROM vehicles');
    return rows.map((r) => JSON.parse(r.json) as VehicleConfig);
  }

  async putVehicle(v: VehicleConfig): Promise<void> {
    await this.db.run(
      'INSERT INTO vehicles (vid, json) VALUES (?, ?) ON CONFLICT(vid) DO UPDATE SET json = excluded.json',
      [v.vid, JSON.stringify(v)],
    );
  }

  async countSensorStates(vid: string): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM sensor_state WHERE vid = ?', [vid]
    );
    return row ? Number(row.count) : 0;
  }

  async getSensorState(vid: string, device: string): Promise<SensorState | null> {
    const row = await this.db.get<{ json: string }>(
      'SELECT json FROM sensor_state WHERE vid = ? AND device = ?', [vid, device],
    );
    return row ? (JSON.parse(row.json) as SensorState) : null;
  }

  async putSensorState(vid: string, device: string, state: SensorState): Promise<void> {
    await this.db.run(
      'INSERT INTO sensor_state (vid, device, json) VALUES (?, ?, ?) ' +
      'ON CONFLICT(vid, device) DO UPDATE SET json = excluded.json',
      [vid, device, JSON.stringify(state)],
    );
  }

  async appendHistory(vid: string, device: string, sample: HistorySample, retentionMs: number): Promise<void> {
    if (retentionMs <= 0) return; // tier keeps no history
    // Mirror MemoryStorage exactly: load, drop-by-retention, append, downsample older-than-raw to
    // hourly, enforce the hard cap, then rewrite the device's rows. Bounded by MAX_HISTORY_SAMPLES.
    const existing = await this.getHistory(vid, device);
    const cutoff = sample.at - retentionMs;
    let list = existing.filter((s) => s.at >= cutoff);
    list.push(sample);
    list = downsampleHistory(list, sample.at, RAW_WINDOW_MS);
    if (list.length > MAX_HISTORY_SAMPLES) list = list.slice(list.length - MAX_HISTORY_SAMPLES);

    await this.db.run('DELETE FROM history WHERE vid = ? AND device = ?', [vid, device]);
    for (const s of list) {
      await this.db.run('INSERT INTO history (vid, device, at, extra) VALUES (?, ?, ?, ?)',
        [vid, device, s.at, JSON.stringify(s.extra)]);
    }
  }

  async getHistory(vid: string, device: string, sinceMs?: number): Promise<HistorySample[]> {
    const rows = sinceMs == null
      ? await this.db.all<{ at: number; extra: string }>(
          'SELECT at, extra FROM history WHERE vid = ? AND device = ? ORDER BY at ASC', [vid, device])
      : await this.db.all<{ at: number; extra: string }>(
          'SELECT at, extra FROM history WHERE vid = ? AND device = ? AND at >= ? ORDER BY at ASC',
          [vid, device, sinceMs]);
    return rows.map((r) => ({ at: Number(r.at), extra: JSON.parse(r.extra) as Record<string, string> }));
  }

  async getUserFcmToken(uid: string): Promise<string | null> {
    const row = await this.db.get<{ token: string }>('SELECT token FROM user_tokens WHERE uid = ?', [uid]);
    return row ? row.token : null;
  }

  async putUserFcmToken(uid: string, token: string): Promise<void> {
    await this.db.run(
      'INSERT INTO user_tokens (uid, token) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET token = excluded.token',
      [uid, token],
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }
}

/**
 * `node:sqlite` driver — synchronous under the hood, wrapped to the async SqlDriver shape. Pass a
 * file path for a durable self-host store, or ':memory:' (the default) for tests.
 */
export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
  }
  async exec(sql: string): Promise<void> { this.db.exec(sql); }
  async run(sql: string, params: unknown[] = []): Promise<void> { this.db.prepare(sql).run(...(params as any[])); }
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> { return this.db.prepare(sql).all(...(params as any[])) as T[]; }
  async get<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...(params as any[])) as T) ?? null;
  }
  close(): void { this.db.close(); }
}

/** Convenience builder: a SqlStorage on node:sqlite, schema initialized. */
export async function createSqliteStorage(path?: string): Promise<SqlStorage> {
  const storage = new SqlStorage(new NodeSqliteDriver(path));
  await storage.init();
  return storage;
}
