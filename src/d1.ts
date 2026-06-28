// Cloudflare D1 driver for SqlStorage (open-tasks Task 7 — the hosted Cloudflare adapter). Adapts a
// D1 database binding to the shared `SqlDriver` interface so the SAME SqlStorage runs on D1 (hosted)
// and node:sqlite (self-host). Minimal structural D1 types are declared here so this Node package
// doesn't need to depend on @cloudflare/workers-types just for the binding shape.

import type { SqlDriver } from './sql.js';

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<unknown>;
}

/**
 * Adapt a D1 binding to SqlDriver. D1's `exec` runs the (newline-separated, param-free) schema; the
 * parameterized run/all/get go through prepare().bind(). Matches SqlStorage's `?` placeholders.
 */
export class D1Driver implements SqlDriver {
  constructor(private readonly db: D1Database) {}

  async exec(sql: string): Promise<void> {
    // D1 exec runs one statement per line; collapse the schema to single-line statements.
    const oneLine = sql.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
      .replace(/;\s*/g, ';\n');
    await this.db.exec(oneLine);
  }
  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.prepare(sql).bind(...params).run();
  }
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.prepare(sql).bind(...params).all<T>()).results;
  }
  async get<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.db.prepare(sql).bind(...params).first<T>();
  }
}
