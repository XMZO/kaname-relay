import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applySqliteMigrations,
  D1Store,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type NewOutboxItem,
  type OutboxItem,
} from './index.js';

interface Harness {
  db: Database.Database;
  d1: FakeD1Database;
  store: D1Store;
  dir: string;
}

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

class FakeD1Database implements D1DatabaseLike {
  public constructor(private readonly db: Database.Database) {}

  public prepare(query: string): D1PreparedStatementLike {
    return new FakeD1PreparedStatement(this.db, query, []);
  }

  public batch<T = unknown>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>> {
    const runBatch = this.db.transaction(() =>
      statements.map((statement) => (statement as FakeD1PreparedStatement).execute<T>()),
    );

    return Promise.resolve(runBatch());
  }
}

class FakeD1PreparedStatement implements D1PreparedStatementLike {
  public constructor(
    private readonly db: Database.Database,
    private readonly query: string,
    private readonly values: unknown[],
  ) {}

  public bind(...values: unknown[]): D1PreparedStatementLike {
    return new FakeD1PreparedStatement(this.db, this.query, values);
  }

  public first<T = unknown>(): Promise<T | null> {
    const row = this.db.prepare(this.query).get(...this.values) as T | undefined;

    return Promise.resolve(row ?? null);
  }

  public all<T = unknown>(): Promise<D1ResultLike<T>> {
    return Promise.resolve(this.execute<T>());
  }

  public run<T = unknown>(): Promise<D1ResultLike<T>> {
    return Promise.resolve(this.execute<T>());
  }

  public execute<T = unknown>(): D1ResultLike<T> {
    const hasReturning = /\bRETURNING\b/i.test(this.query);

    if (hasReturning || /^\s*SELECT\b/i.test(this.query)) {
      const rows = this.db.prepare(this.query).all(...this.values) as T[];

      return {
        results: rows,
        meta: {
          changes: hasReturning ? rows.length : 0,
        },
      };
    }

    const result = this.db.prepare(this.query).run(...this.values);

    return {
      results: [],
      meta: {
        changes: result.changes,
      },
    };
  }
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-d1-store-'));
  const db = new Database(join(dir, 'test.sqlite'));
  cleanupHandles.push({ db, dir });
  applySqliteMigrations(db);
  seedSourceAndChannel(db);

  const d1 = new FakeD1Database(db);

  return {
    db,
    d1,
    store: new D1Store(d1),
    dir,
  };
}

function seedSourceAndChannel(db: Database.Database, now = 1_000): void {
  db.prepare(
    `
    INSERT INTO webhook_sources (
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (
      'source-1', 'Source 1', 'generic', 1, '{}', ?, ?
    )
    `,
  ).run(now, now);

  db.prepare(
    `
    INSERT INTO channels (
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (
      'channel-1', 'Telegram', 'telegram', 1, '{}', ?, ?
    )
    `,
  ).run(now, now);
}

function outboxItem(id: string, overrides: Partial<NewOutboxItem> = {}): NewOutboxItem {
  return {
    id,
    sourceId: 'source-1',
    channelId: 'channel-1',
    notifierType: 'telegram',
    nextAt: 1_000,
    inboundDedupeKey: 'event-1',
    outboundDedupeKey: `source-1:event-1:rule:${id}`,
    eventType: 'test',
    payloadJson: '{"ok":true}',
    messageJson: '{"text":"hello"}',
    ...overrides,
  };
}

function insertOutboxRow(
  db: Database.Database,
  id: string,
  overrides: Partial<{
    status: string;
    attempts: number;
    maxAttempts: number;
    nextAt: number;
    lockedUntil: number | null;
    leaseId: string | null;
    outboundDedupeKey: string | null;
  }> = {},
): void {
  db.prepare(
    `
    INSERT INTO outbox (
      id, source_id, channel_id, notifier_type, status,
      priority, next_at, locked_until, lease_id, attempts, max_attempts,
      outbound_dedupe_key, payload_json, message_json, created_at, updated_at
    ) VALUES (
      :id, 'source-1', 'channel-1', 'telegram', :status,
      0, :next_at, :locked_until, :lease_id, :attempts, :max_attempts,
      :outbound_dedupe_key, '{"ok":true}', '{"text":"hello"}', 1, 1
    )
    `,
  ).run({
    id,
    status: overrides.status ?? 'pending',
    next_at: overrides.nextAt ?? 1_000,
    locked_until: overrides.lockedUntil ?? null,
    lease_id: overrides.leaseId ?? null,
    attempts: overrides.attempts ?? 0,
    max_attempts: overrides.maxAttempts ?? 10,
    outbound_dedupe_key: overrides.outboundDedupeKey ?? `dedupe:${id}`,
  });
}

async function getOutbox(store: D1Store, id: string): Promise<OutboxItem> {
  const item = await store.getOutboxById(id);

  if (!item) {
    throw new Error(`Expected outbox item ${id}`);
  }

  return item;
}

describe('D1Store.ingest', () => {
  it('uses committed partial-index upsert semantics and replays committed=0 placeholders', async () => {
    const { db, store } = createHarness();

    await expect(
      store.ingest({
        now: 2_000,
        receivedEvent: {
          id: 'event-row-1',
          sourceId: 'source-1',
          inboundDedupeKey: 'dedupe-1',
          eventType: 'heartbeat',
          payloadHash: 'hash-1',
        },
        outboxItems: [outboxItem('outbox-1')],
      }),
    ).resolves.toMatchObject({
      duplicate: false,
      receivedEventId: 'event-row-1',
      seenCount: 1,
      outboxCount: 1,
    });

    await expect(
      store.ingest({
        now: 3_000,
        receivedEvent: {
          id: 'event-row-ignored',
          sourceId: 'source-1',
          inboundDedupeKey: 'dedupe-1',
          eventType: 'heartbeat',
          payloadHash: 'hash-1',
        },
        outboxItems: [outboxItem('outbox-ignored')],
      }),
    ).resolves.toMatchObject({
      duplicate: true,
      receivedEventId: 'event-row-1',
      seenCount: 2,
      outboxCount: 0,
    });

    db.prepare(
      `
      INSERT INTO received_events (
        id, source_id, inbound_dedupe_key, event_type, payload_hash,
        first_seen_at, last_seen_at, seen_count, last_outbox_count, committed
      ) VALUES (
        'event-half', 'source-1', 'dedupe-half', 'old', 'old-hash',
        1_000, 1_000, 1, 1, 0
      )
      `,
    ).run();
    db.prepare(
      `
      INSERT INTO outbox (
        id, source_id, received_event_id, channel_id, notifier_type, status,
        priority, next_at, attempts, max_attempts, outbound_dedupe_key,
        payload_json, message_json, created_at, updated_at
      ) VALUES (
        'old-outbox', 'source-1', 'event-half', 'channel-1', 'telegram', 'pending',
        0, 1_000, 0, 10, 'old-dedupe',
        '{"ok":true}', '{"text":"old"}', 1, 1
      )
      `,
    ).run();

    await expect(
      store.ingest({
        now: 4_000,
        receivedEvent: {
          id: 'event-new-id',
          sourceId: 'source-1',
          inboundDedupeKey: 'dedupe-half',
          eventType: 'new',
          payloadHash: 'new-hash',
        },
        outboxItems: [outboxItem('new-outbox', { outboundDedupeKey: 'new-dedupe' })],
      }),
    ).resolves.toMatchObject({
      duplicate: false,
      receivedEventId: 'event-half',
      seenCount: 2,
      outboxCount: 1,
    });

    const outboxRows = db
      .prepare('SELECT id FROM outbox WHERE received_event_id = ?')
      .all('event-half') as Array<{
      id: string;
    }>;
    expect(outboxRows).toEqual([{ id: 'new-outbox' }]);
  });

  it('keeps NULL inbound dedupe keys independent', async () => {
    const { db, store } = createHarness();

    await store.ingest({
      now: 2_000,
      receivedEvent: {
        id: 'event-null-1',
        sourceId: 'source-1',
        payloadHash: 'hash-null-1',
      },
      outboxItems: [
        outboxItem('outbox-null-1', { inboundDedupeKey: null, outboundDedupeKey: null }),
      ],
    });
    await store.ingest({
      now: 3_000,
      receivedEvent: {
        id: 'event-null-2',
        sourceId: 'source-1',
        payloadHash: 'hash-null-2',
      },
      outboxItems: [
        outboxItem('outbox-null-2', { inboundDedupeKey: null, outboundDedupeKey: null }),
      ],
    });

    const receivedCount = db.prepare('SELECT COUNT(*) AS count FROM received_events').get() as {
      count: number;
    };
    const outboxCount = db.prepare('SELECT COUNT(*) AS count FROM outbox').get() as {
      count: number;
    };

    expect(receivedCount.count).toBe(2);
    expect(outboxCount.count).toBe(2);
  });
});

describe('D1Store outbox leases', () => {
  it('claims due rows once and recovers expired leases with attempts/backoff/dead terminal state', async () => {
    const { db, store } = createHarness();

    insertOutboxRow(db, 'claim-me', { nextAt: 900 });
    insertOutboxRow(db, 'claim-later', { nextAt: 2_000 });

    const claimed = await store.claimDueOutbox({
      now: 1_000,
      leaseId: 'lease-claim',
      leaseUntil: 10_000,
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).toEqual(['claim-me']);
    await expect(
      store.claimDueOutbox({
        now: 1_000,
        leaseId: 'lease-other',
        leaseUntil: 10_000,
        limit: 10,
      }),
    ).resolves.toEqual([]);

    insertOutboxRow(db, 'expired-retry', {
      status: 'sending',
      attempts: 0,
      maxAttempts: 3,
      lockedUntil: 5_000,
      leaseId: 'lease-old',
    });
    insertOutboxRow(db, 'expired-dead', {
      status: 'sending',
      attempts: 2,
      maxAttempts: 3,
      lockedUntil: 5_000,
      leaseId: 'lease-old',
    });

    await expect(
      store.recoverExpiredLeases({
        now: 10_000,
        limit: 10,
        backoffDelaysMsByAttempt: {
          1: 30_000,
          2: 60_000,
        },
        maxBackoffDelayMs: 1_800_000,
      }),
    ).resolves.toEqual({ retried: 1, dead: 1 });

    await expect(getOutbox(store, 'expired-retry')).resolves.toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAt: 40_000,
      leaseId: null,
      lockedUntil: null,
      lastError: 'lease expired before completion; scheduled retry',
    });
    await expect(getOutbox(store, 'expired-dead')).resolves.toMatchObject({
      status: 'dead',
      attempts: 3,
      deadAt: 10_000,
      leaseId: null,
      lockedUntil: null,
      lastError: 'repeatedly failed before completion (suspected poison message)',
    });
  });

  it('absorbs sent_log conflicts and guards outbox mutations by lease', async () => {
    const { db, store } = createHarness();
    insertOutboxRow(db, 'sent-original', { outboundDedupeKey: 'same-dedupe' });
    insertOutboxRow(db, 'sent-replay', { outboundDedupeKey: 'same-dedupe-row' });
    insertOutboxRow(db, 'retry-me', {
      status: 'sending',
      lockedUntil: 20_000,
      leaseId: 'lease-a',
    });
    insertOutboxRow(db, 'dead-me', {
      status: 'sending',
      lockedUntil: 20_000,
      leaseId: 'lease-a',
    });
    insertOutboxRow(db, 'cancel-me', {
      status: 'sending',
      lockedUntil: 20_000,
      leaseId: 'lease-a',
    });
    insertOutboxRow(db, 'sent-me', {
      status: 'sending',
      lockedUntil: 20_000,
      leaseId: 'lease-a',
    });

    await expect(
      store.insertSentLog({
        id: 'sent-log-original',
        outboxId: 'sent-original',
        outboundDedupeKey: 'same-dedupe',
        channelId: 'channel-1',
        notifierType: 'telegram',
        providerMessageId: 'provider-original',
        providerResponseJson: '{"ok":true}',
        sentAt: 2_000,
      }),
    ).resolves.toMatchObject({
      inserted: true,
      sentLogId: 'sent-log-original',
    });
    await expect(
      store.insertSentLog({
        id: 'sent-log-replay',
        outboxId: 'sent-replay',
        outboundDedupeKey: 'same-dedupe',
        channelId: 'channel-1',
        notifierType: 'telegram',
        providerMessageId: 'provider-replay',
        providerResponseJson: '{"ok":false}',
        sentAt: 3_000,
      }),
    ).resolves.toEqual({
      inserted: false,
      sentLogId: 'sent-log-original',
      providerMessageId: 'provider-original',
      providerResponseJson: '{"ok":true}',
    });

    await expect(
      store.scheduleOutboxRetryByLease({
        id: 'retry-me',
        leaseId: 'wrong-lease',
        now: 10_000,
        attempts: 1,
        nextAt: 40_000,
        error: 'temporary failure',
      }),
    ).resolves.toBe(false);
    await expect(
      store.scheduleOutboxRetryByLease({
        id: 'retry-me',
        leaseId: 'lease-a',
        now: 10_000,
        attempts: 1,
        nextAt: 40_000,
        error: 'temporary failure',
      }),
    ).resolves.toBe(true);
    await expect(
      store.markOutboxDeadByLease({
        id: 'dead-me',
        leaseId: 'lease-a',
        now: 11_000,
        attempts: 10,
        error: 'permanent failure',
      }),
    ).resolves.toBe(true);
    await expect(
      store.cancelOutboxByLease({
        id: 'cancel-me',
        leaseId: 'lease-a',
        now: 12_000,
        reason: 'channel disabled',
      }),
    ).resolves.toBe(true);
    await expect(
      store.markOutboxSentByLease({
        id: 'sent-me',
        leaseId: 'lease-a',
        now: 13_000,
        providerMessageId: 'provider-1',
        providerResponseJson: '{"ok":true}',
      }),
    ).resolves.toBe(true);

    await expect(getOutbox(store, 'retry-me')).resolves.toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAt: 40_000,
    });
    await expect(getOutbox(store, 'dead-me')).resolves.toMatchObject({
      status: 'dead',
      attempts: 10,
      deadAt: 11_000,
    });
    await expect(getOutbox(store, 'cancel-me')).resolves.toMatchObject({
      status: 'cancelled',
      cancelledAt: 12_000,
    });
    await expect(getOutbox(store, 'sent-me')).resolves.toMatchObject({
      status: 'sent',
      sentAt: 13_000,
      providerMessageId: 'provider-1',
      providerResponseJson: '{"ok":true}',
    });
  });
});
