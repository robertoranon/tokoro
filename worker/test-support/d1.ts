// Minimal in-memory stand-in for D1 on top of node:sqlite, so handler tests
// run real SQL. Supports prepare().bind().run()/first()/all().
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

function statement(db: any, sql: string, params: unknown[]) {
  return {
    bind: (...next: unknown[]) => statement(db, sql, next),
    async run() {
      const r = db.prepare(sql).run(...params);
      return {
        success: true,
        meta: {
          changes: Number(r.changes),
          last_row_id: Number(r.lastInsertRowid),
        },
      };
    },
    async first() {
      const row = db.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
    async all() {
      return {
        success: true,
        results: db
          .prepare(sql)
          .all(...params)
          .map((r: object) => ({ ...r })),
      };
    },
  };
}

/** A fresh database with the named migration files applied (from worker/migrations). */
export function makeD1(
  migrations: string[] = ['0007_add_members.sql']
): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const name of migrations) {
    const file = fileURLToPath(
      new URL(`../migrations/${name}`, import.meta.url)
    );
    db.exec(readFileSync(file, 'utf8'));
  }
  return {
    prepare: (sql: string) => statement(db, sql, []),
  } as unknown as D1Database;
}
