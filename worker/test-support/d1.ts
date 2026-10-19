// Minimal in-memory stand-in for D1 on top of node:sqlite, so handler tests
// run real SQL. Supports prepare().bind().run()/first()/all() and
// batch([...]) (one transaction, rolled back when a statement fails).
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

const toObjects = (rows: object[]) => rows.map(r => ({ ...r }));

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
        results: toObjects(db.prepare(sql).all(...params)),
      };
    },
    /** Synchronous execution for batch(): rows for queries, changes for writes. */
    _exec() {
      const s = db.prepare(sql);
      if (s.columns().length > 0) {
        return {
          success: true,
          meta: { changes: 0, last_row_id: 0 },
          results: toObjects(s.all(...params)),
        };
      }
      const r = s.run(...params);
      return {
        success: true,
        meta: {
          changes: Number(r.changes),
          last_row_id: Number(r.lastInsertRowid),
        },
        results: [],
      };
    },
  };
}

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../migrations/', import.meta.url)
);

/** Every migration file, in order (0001_…, 0002_…). */
export const ALL_MIGRATIONS: string[] = readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort();

/** A fresh database with the named migration files applied (from worker/migrations). */
export function makeD1(migrations: string[] = ALL_MIGRATIONS): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const name of migrations) {
    const file = fileURLToPath(
      new URL(`../migrations/${name}`, import.meta.url)
    );
    db.exec(readFileSync(file, 'utf8'));
  }
  return {
    prepare: (sql: string) => statement(db, sql, []),
    async batch(statements: ReturnType<typeof statement>[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map(s => s._exec());
        db.exec('COMMIT');
        return results;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
