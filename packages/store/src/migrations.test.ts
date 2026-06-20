import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applySqliteMigrations, defaultMigrationsDir } from './index.js';

const cleanupHandles: Array<{ db: Database.Database; dir: string }> = [];

afterEach(() => {
  while (cleanupHandles.length > 0) {
    const handle = cleanupHandles.pop();

    if (handle) {
      handle.db.close();
      rmSync(handle.dir, { force: true, recursive: true });
    }
  }
});

function createDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-migrations-'));
  const db = new Database(join(dir, 'test.sqlite'));
  cleanupHandles.push({ db, dir });

  return db;
}

describe('applySqliteMigrations', () => {
  it('records migrations and skips them on the next startup', () => {
    const db = createDb();

    expect(applySqliteMigrations(db)).toEqual(['0001_initial.sql']);
    expect(applySqliteMigrations(db)).toEqual([]);
    expect(migrationIds(db)).toEqual(['0001_initial.sql']);
  });

  it('baselines a database initialized by the pre-journal migrator', () => {
    const db = createDb();
    db.exec(readFileSync(join(defaultMigrationsDir, '0001_initial.sql'), 'utf8'));

    expect(applySqliteMigrations(db)).toEqual(['0001_initial.sql']);
    expect(applySqliteMigrations(db)).toEqual([]);
    expect(migrationIds(db)).toEqual(['0001_initial.sql']);
  });

  it('does not baseline a partially created schema', () => {
    const db = createDb();
    db.exec('CREATE TABLE webhook_sources (id TEXT PRIMARY KEY)');

    expect(() => applySqliteMigrations(db)).toThrow(/webhook_sources already exists/);
    expect(migrationIds(db)).toEqual([]);
  });
});

function migrationIds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
    id: string;
  }>;

  return rows.map((row) => row.id);
}
