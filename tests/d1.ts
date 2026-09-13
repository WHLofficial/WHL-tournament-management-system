// 测试基建：把 node:sqlite 包成 D1 兼容接口（只实现平台代码用到的面：
// prepare/bind/first/all/run + batch 隐式事务），并按文件名序跑全部迁移。
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function createTestKV(seed: Map<string, string> = new Map()) {
  return {
    async get(key: string) {
      return seed.get(key) ?? null;
    },
    async put(key: string, value: string) {
      seed.set(key, value);
    },
    async delete(key: string) {
      seed.delete(key);
    },
  };
}

export function createTestD1(sqlite: DatabaseSync): D1Database {
  const d1 = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          args = bound;
          return stmt;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          return (sqlite.prepare(sql).get(...(args as never[])) ?? null) as T | null;
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: sqlite.prepare(sql).all(...(args as never[])) as T[] };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(args as never[]));
          return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        },
      };
      return stmt;
    },
    async batch(statements: { run(): Promise<{ meta: { changes: number } }> }[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const out: { meta: { changes: number } }[] = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return d1 as unknown as D1Database;
}

export function applyMigrations(sqlite: DatabaseSync): void {
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  // 与 wrangler d1 migrations 同序：按文件名字典序（注意仓库里 0004 有两个文件）
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(dir + file, "utf8"));
  }
}

export function createTestDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  return { sqlite, db: createTestD1(sqlite) };
}

// node:sqlite StatementSync 的 get/all 不带泛型，包一层方便断言取行
type SqlParam = string | number | bigint | Uint8Array | null;

export function sqlGet<T>(sqlite: DatabaseSync, sql: string, ...params: SqlParam[]): T | undefined {
  return sqlite.prepare(sql).get(...params) as T | undefined;
}

export function sqlAll<T>(sqlite: DatabaseSync, sql: string, ...params: SqlParam[]): T[] {
  return sqlite.prepare(sql).all(...params) as T[];
}
