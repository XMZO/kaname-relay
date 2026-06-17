import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultMigrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export function applySqliteMigrations(
  db: BetterSqlite3.Database,
  migrationsDir = defaultMigrationsDir,
): string[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  db.pragma('foreign_keys = ON');

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }

  return files;
}
