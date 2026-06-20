import type BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
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
  ensureMigrationJournal(db);

  const applied = loadAppliedMigrations(db);
  const appliedNow: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = sha256(sql);
    const appliedChecksum = applied.get(file);

    if (appliedChecksum) {
      if (appliedChecksum !== checksum) {
        throw new Error(`Migration checksum mismatch for ${file}`);
      }

      continue;
    }

    try {
      db.transaction(() => {
        db.exec(sql);
        recordMigration(db, file, checksum);
      })();
      applied.set(file, checksum);
      appliedNow.push(file);
    } catch (error) {
      if (canBaselineExistingInitialMigration(db, file, applied)) {
        recordMigration(db, file, checksum);
        applied.set(file, checksum);
        appliedNow.push(file);
        continue;
      }

      throw error;
    }
  }

  return appliedNow;
}

function ensureMigrationJournal(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

function loadAppliedMigrations(db: BetterSqlite3.Database): Map<string, string> {
  const rows = db.prepare('SELECT id, checksum FROM schema_migrations').all() as Array<{
    id: string;
    checksum: string;
  }>;

  return new Map(rows.map((row) => [row.id, row.checksum]));
}

function recordMigration(db: BetterSqlite3.Database, id: string, checksum: string): void {
  db.prepare(
    `
    INSERT INTO schema_migrations (id, checksum, applied_at)
    VALUES (?, ?, ?)
    `,
  ).run(id, checksum, Date.now());
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function canBaselineExistingInitialMigration(
  db: BetterSqlite3.Database,
  file: string,
  applied: Map<string, string>,
): boolean {
  return file === '0001_initial.sql' && applied.size === 0 && hasInitialSchemaObjects(db);
}

function hasInitialSchemaObjects(db: BetterSqlite3.Database): boolean {
  const rows = db
    .prepare(
      `
      SELECT type, name
      FROM sqlite_master
      WHERE type IN ('table', 'index')
      `,
    )
    .all() as Array<{ type: string; name: string }>;
  const objects = new Set(rows.map((row) => `${row.type}:${row.name}`));

  return initialSchemaObjects.every((object) => objects.has(`${object.type}:${object.name}`));
}

const initialSchemaObjects = [
  { type: 'table', name: 'webhook_sources' },
  { type: 'index', name: 'idx_webhook_sources_type_enabled' },
  { type: 'table', name: 'channels' },
  { type: 'index', name: 'idx_channels_type_enabled' },
  { type: 'table', name: 'rules' },
  { type: 'index', name: 'idx_rules_source_enabled_priority' },
  { type: 'index', name: 'idx_rules_enabled_priority' },
  { type: 'table', name: 'rule_channels' },
  { type: 'index', name: 'idx_rule_channels_channel_enabled' },
  { type: 'table', name: 'received_events' },
  { type: 'index', name: 'idx_received_events_source_dedupe' },
  { type: 'index', name: 'idx_received_events_seen' },
  { type: 'index', name: 'idx_received_events_payload_hash' },
  { type: 'table', name: 'outbox' },
  { type: 'index', name: 'idx_outbox_outbound_dedupe' },
  { type: 'index', name: 'idx_outbox_due' },
  { type: 'index', name: 'idx_outbox_lease_expired' },
  { type: 'index', name: 'idx_outbox_channel_status' },
  { type: 'index', name: 'idx_outbox_source_created' },
  { type: 'table', name: 'sent_log' },
  { type: 'index', name: 'idx_sent_log_outbox' },
  { type: 'index', name: 'idx_sent_log_outbound_dedupe' },
  { type: 'index', name: 'idx_sent_log_channel_sent' },
  { type: 'table', name: 'app_settings' },
];
