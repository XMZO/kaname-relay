import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applySqliteMigrations,
  SqliteProcessPendingStore,
  SqliteStore,
  type NewOutboxItem,
  type OutboxItem,
} from './index.js';

interface Harness {
  db: Database.Database;
  store: SqliteStore;
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

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-store-'));

  const db = new Database(join(dir, 'test.sqlite'));
  cleanupHandles.push({ db, dir });
  applySqliteMigrations(db);
  seedSourceAndChannel(db);

  return {
    db,
    store: new SqliteStore(db),
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
    receivedEventId: string | null;
    messageJson: string;
  }> = {},
): void {
  db.prepare(
    `
    INSERT INTO outbox (
      id, source_id, received_event_id, channel_id, notifier_type, status,
      priority, next_at, locked_until, lease_id, attempts, max_attempts,
      outbound_dedupe_key, payload_json, message_json, created_at, updated_at
    ) VALUES (
      :id, 'source-1', :received_event_id, 'channel-1', 'telegram', :status,
      0, :next_at, :locked_until, :lease_id, :attempts, :max_attempts,
      :outbound_dedupe_key, '{"ok":true}', :message_json, 1, 1
    )
    `,
  ).run({
    id,
    received_event_id: overrides.receivedEventId ?? null,
    status: overrides.status ?? 'pending',
    next_at: overrides.nextAt ?? 1_000,
    locked_until: overrides.lockedUntil ?? null,
    lease_id: overrides.leaseId ?? null,
    attempts: overrides.attempts ?? 0,
    max_attempts: overrides.maxAttempts ?? 10,
    outbound_dedupe_key: overrides.outboundDedupeKey ?? `dedupe:${id}`,
    message_json: overrides.messageJson ?? '{"text":"hello"}',
  });
}

async function getOutbox(store: SqliteStore, id: string): Promise<OutboxItem> {
  const item = await store.getOutboxById(id);

  if (!item) {
    throw new Error(`Expected outbox item ${id}`);
  }

  return item;
}

describe('store migration', () => {
  it('creates the initial tables, indexes, and committed column', () => {
    const { db } = createHarness();

    const tables = db
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
        `,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      'app_settings',
      'channels',
      'outbox',
      'received_events',
      'rule_channels',
      'rules',
      'schema_migrations',
      'sent_log',
      'webhook_sources',
    ]);

    const receivedColumns = db.prepare('PRAGMA table_info(received_events)').all() as Array<{
      name: string;
    }>;
    expect(receivedColumns.map((column) => column.name)).toContain('committed');

    const outboxIndexes = db.prepare('PRAGMA index_list(outbox)').all() as Array<{
      name: string;
    }>;
    expect(outboxIndexes.map((index) => index.name)).toContain('idx_outbox_due');

    const receivedDedupeIndex = db
      .prepare(
        `
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_received_events_source_dedupe'
        `,
      )
      .get() as { sql: string };
    expect(receivedDedupeIndex.sql).toContain('WHERE inbound_dedupe_key IS NOT NULL');
  });
});

describe('SqliteStore.ingest', () => {
  it('commits an empty outbox and treats committed duplicates as duplicates', async () => {
    const { db, store } = createHarness();

    const first = await store.ingest({
      now: 2_000,
      receivedEvent: {
        id: 'event-row-1',
        sourceId: 'source-1',
        inboundDedupeKey: 'dedupe-1',
        eventType: 'heartbeat',
        payloadHash: 'hash-1',
      },
      outboxItems: [],
    });

    expect(first).toEqual({
      duplicate: false,
      committed: true,
      receivedEventId: 'event-row-1',
      seenCount: 1,
      outboxCount: 0,
    });

    const duplicate = await store.ingest({
      now: 3_000,
      receivedEvent: {
        id: 'event-row-2',
        sourceId: 'source-1',
        inboundDedupeKey: 'dedupe-1',
        eventType: 'heartbeat',
        payloadHash: 'hash-1',
      },
      outboxItems: [outboxItem('outbox-ignored')],
    });

    expect(duplicate).toMatchObject({
      duplicate: true,
      committed: true,
      receivedEventId: 'event-row-1',
      seenCount: 2,
      outboxCount: 0,
    });

    const eventRow = db
      .prepare('SELECT committed, last_outbox_count FROM received_events')
      .get() as {
      committed: number;
      last_outbox_count: number;
    };
    expect(eventRow).toEqual({ committed: 1, last_outbox_count: 0 });

    const outboxCount = db.prepare('SELECT COUNT(*) AS count FROM outbox').get() as {
      count: number;
    };
    expect(outboxCount.count).toBe(0);
  });

  it('treats NULL inbound dedupe keys as independent events', async () => {
    const { db, store } = createHarness();

    const first = await store.ingest({
      now: 2_000,
      receivedEvent: {
        id: 'event-null-1',
        sourceId: 'source-1',
        eventType: 'generic',
        payloadHash: 'hash-null-1',
      },
      outboxItems: [
        outboxItem('outbox-null-1', {
          inboundDedupeKey: null,
          outboundDedupeKey: null,
        }),
      ],
    });

    const second = await store.ingest({
      now: 3_000,
      receivedEvent: {
        id: 'event-null-2',
        sourceId: 'source-1',
        eventType: 'generic',
        payloadHash: 'hash-null-2',
      },
      outboxItems: [
        outboxItem('outbox-null-2', {
          inboundDedupeKey: null,
          outboundDedupeKey: null,
        }),
      ],
    });

    expect(first).toMatchObject({
      duplicate: false,
      receivedEventId: 'event-null-1',
      outboxCount: 1,
    });
    expect(second).toMatchObject({
      duplicate: false,
      receivedEventId: 'event-null-2',
      outboxCount: 1,
    });

    const receivedCount = db.prepare('SELECT COUNT(*) AS count FROM received_events').get() as {
      count: number;
    };
    expect(receivedCount.count).toBe(2);

    const outboxCount = db.prepare('SELECT COUNT(*) AS count FROM outbox').get() as {
      count: number;
    };
    expect(outboxCount.count).toBe(2);
  });

  it('reprocesses committed=0 placeholders instead of dropping them as duplicates', async () => {
    const { db, store } = createHarness();

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
    insertOutboxRow(db, 'old-outbox', {
      receivedEventId: 'event-half',
      outboundDedupeKey: 'old-dedupe',
    });

    const result = await store.ingest({
      now: 4_000,
      receivedEvent: {
        id: 'event-new-id-is-not-used',
        sourceId: 'source-1',
        inboundDedupeKey: 'dedupe-half',
        eventType: 'new',
        payloadHash: 'new-hash',
      },
      outboxItems: [
        outboxItem('new-outbox', {
          inboundDedupeKey: 'dedupe-half',
          outboundDedupeKey: 'new-dedupe',
        }),
      ],
    });

    expect(result).toEqual({
      duplicate: false,
      committed: true,
      receivedEventId: 'event-half',
      seenCount: 2,
      outboxCount: 1,
    });

    const outboxRows = db
      .prepare('SELECT id, received_event_id FROM outbox ORDER BY id')
      .all() as Array<{ id: string; received_event_id: string }>;
    expect(outboxRows).toEqual([{ id: 'new-outbox', received_event_id: 'event-half' }]);

    const eventRow = db.prepare('SELECT committed, payload_hash FROM received_events').get() as {
      committed: number;
      payload_hash: string;
    };
    expect(eventRow).toEqual({ committed: 1, payload_hash: 'new-hash' });
  });
});

describe('SqliteStore outbox lease methods', () => {
  it('claims due pending rows with a lease', async () => {
    const { store } = createHarness();

    await store.ingest({
      now: 1_000,
      receivedEvent: {
        id: 'event-claim',
        sourceId: 'source-1',
        inboundDedupeKey: 'claim',
        eventType: 'test',
        payloadHash: 'hash-claim',
      },
      outboxItems: [
        outboxItem('claim-low', { priority: 1, nextAt: 900, outboundDedupeKey: 'claim-low' }),
        outboxItem('claim-high', { priority: 10, nextAt: 900, outboundDedupeKey: 'claim-high' }),
        outboxItem('claim-later', {
          priority: 99,
          nextAt: 2_000,
          outboundDedupeKey: 'claim-later',
        }),
      ],
    });

    const claimed = await store.claimDueOutbox({
      now: 1_000,
      leaseId: 'lease-claim',
      leaseUntil: 10_000,
      limit: 2,
    });

    expect(new Set(claimed.map((item) => item.id))).toEqual(new Set(['claim-low', 'claim-high']));

    const high = await getOutbox(store, 'claim-high');
    expect(high).toMatchObject({
      status: 'sending',
      leaseId: 'lease-claim',
      lockedUntil: 10_000,
    });

    const later = await getOutbox(store, 'claim-later');
    expect(later.status).toBe('pending');

    const secondClaim = await store.claimDueOutbox({
      now: 1_000,
      leaseId: 'lease-other',
      leaseUntil: 11_000,
      limit: 10,
    });
    expect(secondClaim).toEqual([]);
  });

  it('recovers expired leases by counting attempts, backing off, and killing poison rows', async () => {
    const { store, db } = createHarness();

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
    insertOutboxRow(db, 'still-locked', {
      status: 'sending',
      attempts: 0,
      maxAttempts: 3,
      lockedUntil: 20_000,
      leaseId: 'lease-live',
    });

    const result = await store.recoverExpiredLeases({
      now: 10_000,
      limit: 10,
      backoffDelaysMsByAttempt: {
        1: 30_000,
        2: 60_000,
        3: 120_000,
      },
      maxBackoffDelayMs: 1_800_000,
    });

    expect(result).toEqual({ retried: 1, dead: 1 });

    const retried = await getOutbox(store, 'expired-retry');
    expect(retried).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAt: 40_000,
      lockedUntil: null,
      leaseId: null,
      lastError: 'lease expired before completion; scheduled retry',
      lastErrorAt: 10_000,
    });

    const dead = await getOutbox(store, 'expired-dead');
    expect(dead).toMatchObject({
      status: 'dead',
      attempts: 3,
      deadAt: 10_000,
      lockedUntil: null,
      leaseId: null,
      lastError: 'repeatedly failed before completion (suspected poison message)',
    });

    const live = await getOutbox(store, 'still-locked');
    expect(live).toMatchObject({
      status: 'sending',
      attempts: 0,
      leaseId: 'lease-live',
    });
  });

  it('absorbs sent_log uniqueness conflicts and returns the existing success row', async () => {
    const { store, db } = createHarness();
    insertOutboxRow(db, 'sent-outbox');

    const inserted = await store.insertSentLog({
      id: 'sent-log-1',
      outboxId: 'sent-outbox',
      outboundDedupeKey: 'sent-dedupe',
      channelId: 'channel-1',
      notifierType: 'telegram',
      providerMessageId: 'message-1',
      providerResponseJson: '{"ok":true}',
      sentAt: 2_000,
    });

    expect(inserted).toEqual({
      inserted: true,
      sentLogId: 'sent-log-1',
      providerMessageId: 'message-1',
      providerResponseJson: '{"ok":true}',
    });

    const duplicate = await store.insertSentLog({
      id: 'sent-log-2',
      outboxId: 'sent-outbox',
      outboundDedupeKey: 'sent-dedupe',
      channelId: 'channel-1',
      notifierType: 'telegram',
      providerMessageId: 'message-2',
      providerResponseJson: '{"ok":false}',
      sentAt: 3_000,
    });

    expect(duplicate).toEqual({
      inserted: false,
      sentLogId: 'sent-log-1',
      providerMessageId: 'message-1',
      providerResponseJson: '{"ok":true}',
    });

    const count = db.prepare('SELECT COUNT(*) AS count FROM sent_log').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('absorbs sent_log conflicts by outbound dedupe when outbox id differs', async () => {
    const { store, db } = createHarness();
    insertOutboxRow(db, 'sent-original', {
      outboundDedupeKey: 'same-outbound-dedupe',
    });
    insertOutboxRow(db, 'sent-replay', {
      outboundDedupeKey: 'same-outbound-dedupe-replay-row',
    });

    await expect(
      store.insertSentLog({
        id: 'sent-log-original',
        outboxId: 'sent-original',
        outboundDedupeKey: 'same-outbound-dedupe',
        channelId: 'channel-1',
        notifierType: 'telegram',
        providerMessageId: 'provider-original',
        providerResponseJson: '{"ok":true,"original":true}',
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
        outboundDedupeKey: 'same-outbound-dedupe',
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
      providerResponseJson: '{"ok":true,"original":true}',
    });

    const count = db.prepare('SELECT COUNT(*) AS count FROM sent_log').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('only mutates sending rows when the lease matches', async () => {
    const { store, db } = createHarness();

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
      leaseId: null,
      lockedUntil: null,
      lastError: 'temporary failure',
    });
    await expect(getOutbox(store, 'dead-me')).resolves.toMatchObject({
      status: 'dead',
      attempts: 10,
      deadAt: 11_000,
      lastError: 'permanent failure',
    });
    await expect(getOutbox(store, 'cancel-me')).resolves.toMatchObject({
      status: 'cancelled',
      cancelledAt: 12_000,
      lastError: 'channel disabled',
    });
    await expect(getOutbox(store, 'sent-me')).resolves.toMatchObject({
      status: 'sent',
      sentAt: 13_000,
      providerMessageId: 'provider-1',
      providerResponseJson: '{"ok":true}',
    });
  });

  it('dead-letters invalid message_json during process-store claim without throwing', async () => {
    const { store, db } = createHarness();
    const processStore = new SqliteProcessPendingStore(store);

    insertOutboxRow(db, 'bad-message', {
      messageJson: '{"text":',
    });
    insertOutboxRow(db, 'good-message', {
      outboundDedupeKey: 'good-message-dedupe',
    });

    const claimed = await processStore.claimDueOutbox({
      now: 10_000,
      leaseId: 'lease-process',
      leaseUntil: 20_000,
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).toEqual(['good-message']);
    expect(claimed.find((item) => item.id === 'good-message')?.message).toEqual({
      text: 'hello',
    });

    await expect(getOutbox(store, 'bad-message')).resolves.toMatchObject({
      status: 'dead',
      attempts: 1,
      leaseId: null,
      lockedUntil: null,
    });

    const bad = await getOutbox(store, 'bad-message');
    expect(bad.lastError).toContain('invalid message_json');
  });

  it('cleans old sent logs, sent outbox, and orphan received events within a limit', async () => {
    const { store, db } = createHarness();
    db.prepare(
      `
      INSERT INTO received_events (
        id, source_id, payload_hash, first_seen_at, last_seen_at, committed
      ) VALUES
        ('received-old-orphan', 'source-1', 'hash-old-orphan', 1_000, 1_000, 1),
        ('received-old-linked', 'source-1', 'hash-old-linked', 1_000, 1_000, 1),
        ('received-new-orphan', 'source-1', 'hash-new-orphan', 90_000, 90_000, 1)
      `,
    ).run();
    db.prepare(
      `
      INSERT INTO outbox (
        id, source_id, received_event_id, channel_id, notifier_type, status,
        priority, next_at, attempts, max_attempts, outbound_dedupe_key,
        payload_json, message_json, created_at, updated_at, sent_at
      ) VALUES (
        'old-sent-outbox', 'source-1', 'received-old-linked', 'channel-1', 'telegram', 'sent',
        0, 1_000, 0, 10, 'dedupe-old-sent',
        '{"ok":true}', '{"text":"hello"}', 1_000, 1_000, 1_000
      )
      `,
    ).run();
    db.prepare(
      `
      INSERT INTO sent_log (
        id, outbox_id, outbound_dedupe_key, channel_id, notifier_type,
        provider_message_id, sent_at, created_at
      ) VALUES (
        'old-sent-log', 'old-sent-outbox', 'dedupe-old-sent', 'channel-1', 'telegram',
        'provider-old', 1_000, 1_000
      )
      `,
    ).run();

    await expect(
      store.cleanupRetention({
        now: 100_000,
        sentRetentionMs: 30_000,
        receivedRetentionMs: 30_000,
        limit: 10,
      }),
    ).resolves.toEqual({
      sentLogDeleted: 1,
      outboxDeleted: 1,
      receivedEventsDeleted: 2,
    });

    const remainingReceived = db
      .prepare('SELECT id FROM received_events ORDER BY id')
      .all() as Array<{ id: string }>;
    expect(remainingReceived.map((row) => row.id)).toEqual(['received-new-orphan']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sent_log').get()).toEqual({ count: 0 });
  });
});
