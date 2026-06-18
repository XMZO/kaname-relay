import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type {
  CancelOutboxInput,
  ChannelRecord,
  ClaimDueOutboxInput,
  IngestInput,
  IngestResult,
  InsertSentLogResult,
  MarkOutboxDeadInput,
  MarkOutboxSentInput,
  NewOutboxItem,
  NewSentLogEntry,
  OutboxItem,
  OutboxStatus,
  RecoverExpiredLeasesInput,
  RecoverExpiredLeasesResult,
  RuleChannelRecord,
  RuleRecord,
  ScheduleOutboxRetryInput,
  SentLogEntry,
  WebhookSourceRecord,
} from './types.js';

interface ReceivedEventIngestRow {
  id: string;
  seen_count: number;
  committed: 0 | 1;
}

interface SentLogRow {
  id: string;
  provider_message_id: string | null;
  provider_response_json: string | null;
}

interface SentLogFullRow extends SentLogRow {
  outbox_id: string | null;
  outbound_dedupe_key: string | null;
  channel_id: string;
  notifier_type: string;
  sent_at: number;
}

interface WebhookSourceRow {
  id: string;
  name: string;
  type: string;
  enabled: 0 | 1;
  config_json: string;
  secret_json_enc: string | null;
  created_at: number;
  updated_at: number;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  enabled: 0 | 1;
  config_json: string;
  secret_json_enc: string | null;
  created_at: number;
  updated_at: number;
}

interface RuleRow {
  id: string;
  source_id: string | null;
  name: string;
  enabled: 0 | 1;
  priority: number;
  match_json: string;
  template_json: string;
  stop_on_match: 0 | 1;
  created_at: number;
  updated_at: number;
}

interface RuleChannelRow {
  rule_id: string;
  channel_id: string;
  channel_type: string;
  enabled: 0 | 1;
  template_override_json: string | null;
  created_at: number;
  updated_at: number;
}

interface OutboxRow {
  id: string;
  source_id: string;
  received_event_id: string | null;
  rule_id: string | null;
  channel_id: string;
  notifier_type: string;
  status: OutboxStatus;
  priority: number;
  next_at: number;
  locked_until: number | null;
  lease_id: string | null;
  attempts: number;
  max_attempts: number;
  inbound_dedupe_key: string | null;
  outbound_dedupe_key: string | null;
  provider_idempotency_key: string | null;
  event_type: string | null;
  payload_json: string;
  message_json: string;
  last_error: string | null;
  last_error_at: number | null;
  provider_message_id: string | null;
  provider_response_json: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  dead_at: number | null;
  cancelled_at: number | null;
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

function numberOrDefault(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

function mapOutbox(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    sourceId: row.source_id,
    receivedEventId: row.received_event_id,
    ruleId: row.rule_id,
    channelId: row.channel_id,
    notifierType: row.notifier_type,
    status: row.status,
    priority: row.priority,
    nextAt: row.next_at,
    lockedUntil: row.locked_until,
    leaseId: row.lease_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    inboundDedupeKey: row.inbound_dedupe_key,
    outboundDedupeKey: row.outbound_dedupe_key,
    providerIdempotencyKey: row.provider_idempotency_key,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    messageJson: row.message_json,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    providerMessageId: row.provider_message_id,
    providerResponseJson: row.provider_response_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    deadAt: row.dead_at,
    cancelledAt: row.cancelled_at,
  };
}

function sentLogResult(inserted: boolean, row: SentLogRow): InsertSentLogResult {
  const result: InsertSentLogResult = {
    inserted,
    sentLogId: row.id,
  };

  if (row.provider_message_id !== null) {
    result.providerMessageId = row.provider_message_id;
  }

  if (row.provider_response_json !== null) {
    result.providerResponseJson = row.provider_response_json;
  }

  return result;
}

function mapSource(row: WebhookSourceRow): WebhookSourceRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    configJson: row.config_json,
    secretJsonEnc: row.secret_json_enc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChannel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    configJson: row.config_json,
    secretJsonEnc: row.secret_json_enc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRule(row: RuleRow): RuleRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    enabled: row.enabled === 1,
    priority: row.priority,
    matchJson: row.match_json,
    templateJson: row.template_json,
    stopOnMatch: row.stop_on_match === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuleChannel(row: RuleChannelRow): RuleChannelRecord {
  return {
    ruleId: row.rule_id,
    channelId: row.channel_id,
    channelType: row.channel_type,
    enabled: row.enabled === 1,
    templateOverrideJson: row.template_override_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSentLog(row: SentLogFullRow): SentLogEntry {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    outboundDedupeKey: row.outbound_dedupe_key,
    channelId: row.channel_id,
    notifierType: row.notifier_type,
    providerMessageId: row.provider_message_id,
    providerResponseJson: row.provider_response_json,
    sentAt: row.sent_at,
  };
}

function bindOutbox(
  item: NewOutboxItem,
  receivedEventId: string,
  now: number,
): Record<string, unknown> {
  return {
    id: item.id,
    source_id: item.sourceId,
    received_event_id: receivedEventId,
    rule_id: nullable(item.ruleId),
    channel_id: item.channelId,
    notifier_type: item.notifierType,
    priority: numberOrDefault(item.priority, 0),
    next_at: item.nextAt,
    attempts: numberOrDefault(item.attempts, 0),
    max_attempts: numberOrDefault(item.maxAttempts, 10),
    inbound_dedupe_key: nullable(item.inboundDedupeKey),
    outbound_dedupe_key: nullable(item.outboundDedupeKey),
    provider_idempotency_key: nullable(item.providerIdempotencyKey),
    event_type: nullable(item.eventType),
    payload_json: item.payloadJson,
    message_json: item.messageJson,
    created_at: numberOrDefault(item.createdAt, now),
    updated_at: numberOrDefault(item.updatedAt, now),
  };
}

function backoffParams(input: RecoverExpiredLeasesInput): Record<string, number> {
  const params: Record<string, number> = {};

  for (let attempt = 1; attempt <= 9; attempt += 1) {
    params[`delay_${attempt}`] = input.backoffDelaysMsByAttempt[attempt] ?? input.maxBackoffDelayMs;
  }

  params.delay_max = input.maxBackoffDelayMs;

  return params;
}

export class SqliteStore {
  private readonly ingestTx: (input: IngestInput) => IngestResult;

  private readonly recoverExpiredLeasesTx: (
    input: RecoverExpiredLeasesInput,
  ) => RecoverExpiredLeasesResult;

  public constructor(private readonly db: BetterSqlite3.Database) {
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.ingestTx = this.db.transaction((input: IngestInput) => this.ingestSync(input));
    this.recoverExpiredLeasesTx = this.db.transaction((input: RecoverExpiredLeasesInput) =>
      this.recoverExpiredLeasesSync(input),
    );
  }

  public ingest(input: IngestInput): Promise<IngestResult> {
    return Promise.resolve(this.ingestTx(input));
  }

  public claimDueOutbox(input: ClaimDueOutboxInput): Promise<OutboxItem[]> {
    const rows = this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'sending',
          lease_id = :lease_id,
          locked_until = :lease_until,
          updated_at = :now
        WHERE id IN (
          SELECT id
          FROM outbox
          WHERE status = 'pending'
            AND next_at <= :now
          ORDER BY priority DESC, next_at ASC, created_at ASC
          LIMIT :limit
        )
        RETURNING *
        `,
      )
      .all({
        now: input.now,
        lease_id: input.leaseId,
        lease_until: input.leaseUntil,
        limit: input.limit,
      }) as OutboxRow[];

    return Promise.resolve(rows.map(mapOutbox));
  }

  public recoverExpiredLeases(
    input: RecoverExpiredLeasesInput,
  ): Promise<RecoverExpiredLeasesResult> {
    return Promise.resolve(this.recoverExpiredLeasesTx(input));
  }

  public insertSentLog(input: NewSentLogEntry): Promise<InsertSentLogResult> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? input.sentAt;

    const insertResult = this.db
      .prepare(
        `
        INSERT INTO sent_log (
          id, outbox_id, outbound_dedupe_key, channel_id, notifier_type,
          provider_message_id, provider_response_json, sent_at, created_at
        ) VALUES (
          :id, :outbox_id, :outbound_dedupe_key, :channel_id, :notifier_type,
          :provider_message_id, :provider_response_json, :sent_at, :created_at
        )
        ON CONFLICT(outbox_id) WHERE outbox_id IS NOT NULL DO NOTHING
        ON CONFLICT(outbound_dedupe_key) WHERE outbound_dedupe_key IS NOT NULL DO NOTHING
        `,
      )
      .run({
        id,
        outbox_id: input.outboxId,
        outbound_dedupe_key: nullable(input.outboundDedupeKey),
        channel_id: input.channelId,
        notifier_type: input.notifierType,
        provider_message_id: nullable(input.providerMessageId),
        provider_response_json: nullable(input.providerResponseJson),
        sent_at: input.sentAt,
        created_at: createdAt,
      });

    if (insertResult.changes === 1) {
      return Promise.resolve(
        sentLogResult(true, {
          id,
          provider_message_id: input.providerMessageId ?? null,
          provider_response_json: input.providerResponseJson ?? null,
        }),
      );
    }

    const existing = this.findSentLogRow(input.outboxId, input.outboundDedupeKey ?? null);

    if (!existing) {
      throw new Error('sent_log insert was ignored but no existing row was found');
    }

    return Promise.resolve(sentLogResult(false, existing));
  }

  public markOutboxSentByLease(input: MarkOutboxSentInput): Promise<boolean> {
    const result = this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'sent',
          sent_at = :now,
          updated_at = :now,
          locked_until = NULL,
          lease_id = NULL,
          provider_message_id = :provider_message_id,
          provider_response_json = :provider_response_json
        WHERE id = :id
          AND status = 'sending'
          AND lease_id = :lease_id
        `,
      )
      .run({
        id: input.id,
        lease_id: input.leaseId,
        now: input.now,
        provider_message_id: nullable(input.providerMessageId),
        provider_response_json: nullable(input.providerResponseJson),
      });

    return Promise.resolve(result.changes === 1);
  }

  public scheduleOutboxRetryByLease(input: ScheduleOutboxRetryInput): Promise<boolean> {
    const result = this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'pending',
          attempts = :attempts,
          next_at = :next_at,
          locked_until = NULL,
          lease_id = NULL,
          updated_at = :now,
          last_error = :last_error,
          last_error_at = :now
        WHERE id = :id
          AND status = 'sending'
          AND lease_id = :lease_id
        `,
      )
      .run({
        id: input.id,
        lease_id: input.leaseId,
        now: input.now,
        attempts: input.attempts,
        next_at: input.nextAt,
        last_error: input.error,
      });

    return Promise.resolve(result.changes === 1);
  }

  public markOutboxDeadByLease(input: MarkOutboxDeadInput): Promise<boolean> {
    const result = this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'dead',
          attempts = :attempts,
          dead_at = :now,
          updated_at = :now,
          locked_until = NULL,
          lease_id = NULL,
          last_error = :last_error,
          last_error_at = :now
        WHERE id = :id
          AND status = 'sending'
          AND lease_id = :lease_id
        `,
      )
      .run({
        id: input.id,
        lease_id: input.leaseId,
        now: input.now,
        attempts: input.attempts,
        last_error: input.error,
      });

    return Promise.resolve(result.changes === 1);
  }

  public cancelOutboxByLease(input: CancelOutboxInput): Promise<boolean> {
    const result = this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'cancelled',
          cancelled_at = :now,
          updated_at = :now,
          locked_until = NULL,
          lease_id = NULL,
          last_error = :reason,
          last_error_at = :now
        WHERE id = :id
          AND status = 'sending'
          AND lease_id = :lease_id
        `,
      )
      .run({
        id: input.id,
        lease_id: input.leaseId,
        now: input.now,
        reason: input.reason,
      });

    return Promise.resolve(result.changes === 1);
  }

  public getOutboxById(id: string): Promise<OutboxItem | null> {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as
      | OutboxRow
      | undefined;

    return Promise.resolve(row ? mapOutbox(row) : null);
  }

  public getEnabledSource(id: string): Promise<WebhookSourceRecord | null> {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM webhook_sources
        WHERE id = ?
          AND enabled = 1
        `,
      )
      .get(id) as WebhookSourceRow | undefined;

    return Promise.resolve(row ? mapSource(row) : null);
  }

  public getEnabledChannelRecord(id: string): Promise<ChannelRecord | null> {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM channels
        WHERE id = ?
          AND enabled = 1
        `,
      )
      .get(id) as ChannelRow | undefined;

    return Promise.resolve(row ? mapChannel(row) : null);
  }

  public listEnabledRulesForSource(sourceId: string): Promise<RuleRecord[]> {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM rules
        WHERE enabled = 1
          AND (source_id = :source_id OR source_id IS NULL)
        ORDER BY priority DESC, created_at ASC
        `,
      )
      .all({ source_id: sourceId }) as RuleRow[];

    return Promise.resolve(rows.map(mapRule));
  }

  public listEnabledRuleChannels(ruleId: string): Promise<RuleChannelRecord[]> {
    const rows = this.db
      .prepare(
        `
        SELECT
          rule_channels.rule_id,
          rule_channels.channel_id,
          channels.type AS channel_type,
          rule_channels.enabled,
          rule_channels.template_override_json,
          rule_channels.created_at,
          rule_channels.updated_at
        FROM rule_channels
        INNER JOIN channels ON channels.id = rule_channels.channel_id
        WHERE rule_channels.rule_id = ?
          AND rule_channels.enabled = 1
          AND channels.enabled = 1
        ORDER BY rule_channels.created_at ASC
        `,
      )
      .all(ruleId) as RuleChannelRow[];

    return Promise.resolve(rows.map(mapRuleChannel));
  }

  public findSentLogByDedupeKey(outboundDedupeKey: string): Promise<SentLogEntry | null> {
    const row = this.db
      .prepare(
        `
        SELECT
          id, outbox_id, outbound_dedupe_key, channel_id, notifier_type,
          provider_message_id, provider_response_json, sent_at
        FROM sent_log
        WHERE outbound_dedupe_key = ?
        `,
      )
      .get(outboundDedupeKey) as SentLogFullRow | undefined;

    return Promise.resolve(row ? mapSentLog(row) : null);
  }

  private ingestSync(input: IngestInput): IngestResult {
    const event = input.receivedEvent;
    const row = this.db
      .prepare(
        `
        INSERT INTO received_events (
          id, source_id, inbound_dedupe_key, event_type, payload_hash,
          first_seen_at, last_seen_at, seen_count, last_outbox_count, committed
        ) VALUES (
          :id, :source_id, :inbound_dedupe_key, :event_type, :payload_hash,
          :now, :now, 1, 0, 0
        )
        ON CONFLICT(source_id, inbound_dedupe_key)
        WHERE inbound_dedupe_key IS NOT NULL
        DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          seen_count = received_events.seen_count + 1,
          event_type = CASE
            WHEN received_events.committed = 0 THEN excluded.event_type
            ELSE received_events.event_type
          END,
          payload_hash = CASE
            WHEN received_events.committed = 0 THEN excluded.payload_hash
            ELSE received_events.payload_hash
          END
        RETURNING id, seen_count, committed
        `,
      )
      .get({
        id: event.id,
        source_id: event.sourceId,
        inbound_dedupe_key: nullable(event.inboundDedupeKey),
        event_type: nullable(event.eventType),
        payload_hash: event.payloadHash,
        now: input.now,
      }) as ReceivedEventIngestRow | undefined;

    if (!row) {
      throw new Error('received_events ingest returned no row');
    }

    if (row.committed === 1) {
      return {
        duplicate: true,
        committed: true,
        receivedEventId: row.id,
        seenCount: row.seen_count,
        outboxCount: 0,
      };
    }

    this.db.prepare('DELETE FROM outbox WHERE received_event_id = ?').run(row.id);

    const insertOutbox = this.db.prepare(
      `
      INSERT INTO outbox (
        id, source_id, received_event_id, rule_id, channel_id, notifier_type,
        priority, next_at, attempts, max_attempts,
        inbound_dedupe_key, outbound_dedupe_key, provider_idempotency_key,
        event_type, payload_json, message_json, created_at, updated_at
      ) VALUES (
        :id, :source_id, :received_event_id, :rule_id, :channel_id, :notifier_type,
        :priority, :next_at, :attempts, :max_attempts,
        :inbound_dedupe_key, :outbound_dedupe_key, :provider_idempotency_key,
        :event_type, :payload_json, :message_json, :created_at, :updated_at
      )
      `,
    );

    for (const item of input.outboxItems) {
      insertOutbox.run(bindOutbox(item, row.id, input.now));
    }

    this.db
      .prepare(
        `
        UPDATE received_events
        SET
          committed = 1,
          last_outbox_count = :outbox_count,
          last_seen_at = :now
        WHERE id = :id
        `,
      )
      .run({
        id: row.id,
        outbox_count: input.outboxItems.length,
        now: input.now,
      });

    return {
      duplicate: false,
      committed: true,
      receivedEventId: row.id,
      seenCount: row.seen_count,
      outboxCount: input.outboxItems.length,
    };
  }

  private recoverExpiredLeasesSync(input: RecoverExpiredLeasesInput): RecoverExpiredLeasesResult {
    const deadResult = this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'dead',
          attempts = attempts + 1,
          locked_until = NULL,
          lease_id = NULL,
          updated_at = :now,
          dead_at = :now,
          last_error = 'repeatedly failed before completion (suspected poison message)',
          last_error_at = :now
        WHERE id IN (
          SELECT id
          FROM outbox
          WHERE status = 'sending'
            AND locked_until IS NOT NULL
            AND locked_until < :now
            AND attempts + 1 >= max_attempts
          ORDER BY locked_until ASC
          LIMIT :limit
        )
        `,
      )
      .run({ now: input.now, limit: input.limit });

    const retryLimit = Math.max(0, input.limit - deadResult.changes);
    let retried = 0;

    if (retryLimit > 0) {
      const retryResult = this.db
        .prepare(
          `
          UPDATE outbox
          SET
            status = 'pending',
            attempts = attempts + 1,
            next_at = :now + CASE
              WHEN attempts + 1 <= 1 THEN :delay_1
              WHEN attempts + 1 = 2 THEN :delay_2
              WHEN attempts + 1 = 3 THEN :delay_3
              WHEN attempts + 1 = 4 THEN :delay_4
              WHEN attempts + 1 = 5 THEN :delay_5
              WHEN attempts + 1 = 6 THEN :delay_6
              WHEN attempts + 1 = 7 THEN :delay_7
              WHEN attempts + 1 = 8 THEN :delay_8
              WHEN attempts + 1 = 9 THEN :delay_9
              ELSE :delay_max
            END,
            locked_until = NULL,
            lease_id = NULL,
            updated_at = :now,
            last_error = 'lease expired before completion; scheduled retry',
            last_error_at = :now
          WHERE id IN (
            SELECT id
            FROM outbox
            WHERE status = 'sending'
              AND locked_until IS NOT NULL
              AND locked_until < :now
              AND attempts + 1 < max_attempts
            ORDER BY locked_until ASC
            LIMIT :limit
          )
          `,
        )
        .run({
          now: input.now,
          limit: retryLimit,
          ...backoffParams(input),
        });

      retried = retryResult.changes;
    }

    return {
      retried,
      dead: deadResult.changes,
    };
  }

  private findSentLogRow(outboxId: string, outboundDedupeKey: string | null): SentLogRow | null {
    const byOutboxId = this.db
      .prepare(
        `
        SELECT id, provider_message_id, provider_response_json
        FROM sent_log
        WHERE outbox_id = ?
        `,
      )
      .get(outboxId) as SentLogRow | undefined;

    if (byOutboxId) {
      return byOutboxId;
    }

    if (!outboundDedupeKey) {
      return null;
    }

    const byDedupe = this.db
      .prepare(
        `
        SELECT id, provider_message_id, provider_response_json
        FROM sent_log
        WHERE outbound_dedupe_key = ?
        `,
      )
      .get(outboundDedupeKey) as SentLogRow | undefined;

    return byDedupe ?? null;
  }
}
