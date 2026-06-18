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

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
  run<T = unknown>(): Promise<D1ResultLike<T>>;
}

export interface D1ResultLike<T = unknown> {
  results?: T[];
  meta?: {
    changes?: number;
  };
}

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

interface RecoverRow {
  status: OutboxStatus;
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

function bindOutbox(item: NewOutboxItem, receivedEventId: string, now: number): unknown[] {
  return [
    item.id,
    item.sourceId,
    receivedEventId,
    nullable(item.ruleId),
    item.channelId,
    item.notifierType,
    numberOrDefault(item.priority, 0),
    item.nextAt,
    numberOrDefault(item.attempts, 0),
    numberOrDefault(item.maxAttempts, 10),
    nullable(item.inboundDedupeKey),
    nullable(item.outboundDedupeKey),
    nullable(item.providerIdempotencyKey),
    nullable(item.eventType),
    item.payloadJson,
    item.messageJson,
    numberOrDefault(item.createdAt, now),
    numberOrDefault(item.updatedAt, now),
  ];
}

function backoffDelay(input: RecoverExpiredLeasesInput, attempt: number): number {
  return input.backoffDelaysMsByAttempt[attempt] ?? input.maxBackoffDelayMs;
}

export class D1Store {
  public constructor(private readonly db: D1DatabaseLike) {}

  public async ingest(input: IngestInput): Promise<IngestResult> {
    const event = input.receivedEvent;
    const row = await this.db
      .prepare(
        `
        INSERT INTO received_events (
          id, source_id, inbound_dedupe_key, event_type, payload_hash,
          first_seen_at, last_seen_at, seen_count, last_outbox_count, committed
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, 1, 0, 0
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
      .bind(
        event.id,
        event.sourceId,
        nullable(event.inboundDedupeKey),
        nullable(event.eventType),
        event.payloadHash,
        input.now,
        input.now,
      )
      .first<ReceivedEventIngestRow>();

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

    const statements: D1PreparedStatementLike[] = [
      this.db.prepare('DELETE FROM outbox WHERE received_event_id = ?').bind(row.id),
    ];
    const insertOutbox = `
      INSERT INTO outbox (
        id, source_id, received_event_id, rule_id, channel_id, notifier_type,
        priority, next_at, attempts, max_attempts,
        inbound_dedupe_key, outbound_dedupe_key, provider_idempotency_key,
        event_type, payload_json, message_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
      )
      `;

    for (const item of input.outboxItems) {
      statements.push(this.db.prepare(insertOutbox).bind(...bindOutbox(item, row.id, input.now)));
    }

    statements.push(
      this.db
        .prepare(
          `
          UPDATE received_events
          SET
            committed = 1,
            last_outbox_count = ?,
            last_seen_at = ?
          WHERE id = ?
          `,
        )
        .bind(input.outboxItems.length, input.now, row.id),
    );

    await this.db.batch(statements);

    return {
      duplicate: false,
      committed: true,
      receivedEventId: row.id,
      seenCount: row.seen_count,
      outboxCount: input.outboxItems.length,
    };
  }

  public async claimDueOutbox(input: ClaimDueOutboxInput): Promise<OutboxItem[]> {
    const result = await this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'sending',
          lease_id = ?,
          locked_until = ?,
          updated_at = ?
        WHERE id IN (
          SELECT id
          FROM outbox
          WHERE status = 'pending'
            AND next_at <= ?
          ORDER BY priority DESC, next_at ASC, created_at ASC
          LIMIT ?
        )
        RETURNING *
        `,
      )
      .bind(input.leaseId, input.leaseUntil, input.now, input.now, input.limit)
      .all<OutboxRow>();

    return (result.results ?? []).map(mapOutbox);
  }

  public async recoverExpiredLeases(
    input: RecoverExpiredLeasesInput,
  ): Promise<RecoverExpiredLeasesResult> {
    const result = await this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = CASE
            WHEN attempts + 1 >= max_attempts THEN 'dead'
            ELSE 'pending'
          END,
          attempts = attempts + 1,
          next_at = CASE
            WHEN attempts + 1 >= max_attempts THEN next_at
            ELSE ? + CASE
              WHEN attempts + 1 <= 1 THEN ?
              WHEN attempts + 1 = 2 THEN ?
              WHEN attempts + 1 = 3 THEN ?
              WHEN attempts + 1 = 4 THEN ?
              WHEN attempts + 1 = 5 THEN ?
              WHEN attempts + 1 = 6 THEN ?
              WHEN attempts + 1 = 7 THEN ?
              WHEN attempts + 1 = 8 THEN ?
              WHEN attempts + 1 = 9 THEN ?
              ELSE ?
            END
          END,
          locked_until = NULL,
          lease_id = NULL,
          updated_at = ?,
          dead_at = CASE
            WHEN attempts + 1 >= max_attempts THEN ?
            ELSE NULL
          END,
          last_error = CASE
            WHEN attempts + 1 >= max_attempts THEN
              'repeatedly failed before completion (suspected poison message)'
            ELSE
              'lease expired before completion; scheduled retry'
          END,
          last_error_at = ?
        WHERE id IN (
          SELECT id
          FROM outbox
          WHERE status = 'sending'
            AND locked_until IS NOT NULL
            AND locked_until < ?
          ORDER BY locked_until ASC
          LIMIT ?
        )
        RETURNING status
        `,
      )
      .bind(
        input.now,
        backoffDelay(input, 1),
        backoffDelay(input, 2),
        backoffDelay(input, 3),
        backoffDelay(input, 4),
        backoffDelay(input, 5),
        backoffDelay(input, 6),
        backoffDelay(input, 7),
        backoffDelay(input, 8),
        backoffDelay(input, 9),
        input.maxBackoffDelayMs,
        input.now,
        input.now,
        input.now,
        input.now,
        input.limit,
      )
      .all<RecoverRow>();
    const rows = result.results ?? [];

    return {
      retried: rows.filter((row) => row.status === 'pending').length,
      dead: rows.filter((row) => row.status === 'dead').length,
    };
  }

  public async insertSentLog(input: NewSentLogEntry): Promise<InsertSentLogResult> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? input.sentAt;
    const row = await this.db
      .prepare(
        `
        INSERT INTO sent_log (
          id, outbox_id, outbound_dedupe_key, channel_id, notifier_type,
          provider_message_id, provider_response_json, sent_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
        ON CONFLICT(outbox_id) WHERE outbox_id IS NOT NULL DO NOTHING
        ON CONFLICT(outbound_dedupe_key) WHERE outbound_dedupe_key IS NOT NULL DO NOTHING
        RETURNING id, provider_message_id, provider_response_json
        `,
      )
      .bind(
        id,
        input.outboxId,
        nullable(input.outboundDedupeKey),
        input.channelId,
        input.notifierType,
        nullable(input.providerMessageId),
        nullable(input.providerResponseJson),
        input.sentAt,
        createdAt,
      )
      .first<SentLogRow>();

    if (row) {
      return sentLogResult(true, row);
    }

    const existing = await this.findSentLogRow(input.outboxId, input.outboundDedupeKey ?? null);

    if (!existing) {
      throw new Error('sent_log insert was ignored but no existing row was found');
    }

    return sentLogResult(false, existing);
  }

  public async markOutboxSentByLease(input: MarkOutboxSentInput): Promise<boolean> {
    const result = await this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'sent',
          sent_at = ?,
          updated_at = ?,
          locked_until = NULL,
          lease_id = NULL,
          provider_message_id = ?,
          provider_response_json = ?
        WHERE id = ?
          AND status = 'sending'
          AND lease_id = ?
        `,
      )
      .bind(
        input.now,
        input.now,
        nullable(input.providerMessageId),
        nullable(input.providerResponseJson),
        input.id,
        input.leaseId,
      )
      .run();

    return (result.meta?.changes ?? 0) === 1;
  }

  public async scheduleOutboxRetryByLease(input: ScheduleOutboxRetryInput): Promise<boolean> {
    const result = await this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'pending',
          attempts = ?,
          next_at = ?,
          locked_until = NULL,
          lease_id = NULL,
          updated_at = ?,
          last_error = ?,
          last_error_at = ?
        WHERE id = ?
          AND status = 'sending'
          AND lease_id = ?
        `,
      )
      .bind(
        input.attempts,
        input.nextAt,
        input.now,
        input.error,
        input.now,
        input.id,
        input.leaseId,
      )
      .run();

    return (result.meta?.changes ?? 0) === 1;
  }

  public async markOutboxDeadByLease(input: MarkOutboxDeadInput): Promise<boolean> {
    const result = await this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'dead',
          attempts = ?,
          dead_at = ?,
          updated_at = ?,
          locked_until = NULL,
          lease_id = NULL,
          last_error = ?,
          last_error_at = ?
        WHERE id = ?
          AND status = 'sending'
          AND lease_id = ?
        `,
      )
      .bind(input.attempts, input.now, input.now, input.error, input.now, input.id, input.leaseId)
      .run();

    return (result.meta?.changes ?? 0) === 1;
  }

  public async cancelOutboxByLease(input: CancelOutboxInput): Promise<boolean> {
    const result = await this.db
      .prepare(
        `
        UPDATE outbox
        SET
          status = 'cancelled',
          cancelled_at = ?,
          updated_at = ?,
          locked_until = NULL,
          lease_id = NULL,
          last_error = ?,
          last_error_at = ?
        WHERE id = ?
          AND status = 'sending'
          AND lease_id = ?
        `,
      )
      .bind(input.now, input.now, input.reason, input.now, input.id, input.leaseId)
      .run();

    return (result.meta?.changes ?? 0) === 1;
  }

  public async getOutboxById(id: string): Promise<OutboxItem | null> {
    const row = await this.db
      .prepare('SELECT * FROM outbox WHERE id = ?')
      .bind(id)
      .first<OutboxRow>();

    return row ? mapOutbox(row) : null;
  }

  public async getEnabledSource(id: string): Promise<WebhookSourceRecord | null> {
    const row = await this.db
      .prepare(
        `
        SELECT *
        FROM webhook_sources
        WHERE id = ?
          AND enabled = 1
        `,
      )
      .bind(id)
      .first<WebhookSourceRow>();

    return row ? mapSource(row) : null;
  }

  public async getEnabledChannelRecord(id: string): Promise<ChannelRecord | null> {
    const row = await this.db
      .prepare(
        `
        SELECT *
        FROM channels
        WHERE id = ?
          AND enabled = 1
        `,
      )
      .bind(id)
      .first<ChannelRow>();

    return row ? mapChannel(row) : null;
  }

  public async listEnabledRulesForSource(sourceId: string): Promise<RuleRecord[]> {
    const result = await this.db
      .prepare(
        `
        SELECT *
        FROM rules
        WHERE enabled = 1
          AND (source_id = ? OR source_id IS NULL)
        ORDER BY priority DESC, created_at ASC
        `,
      )
      .bind(sourceId)
      .all<RuleRow>();

    return (result.results ?? []).map(mapRule);
  }

  public async listEnabledRuleChannels(ruleId: string): Promise<RuleChannelRecord[]> {
    const result = await this.db
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
      .bind(ruleId)
      .all<RuleChannelRow>();

    return (result.results ?? []).map(mapRuleChannel);
  }

  public async findSentLogByDedupeKey(outboundDedupeKey: string): Promise<SentLogEntry | null> {
    const row = await this.db
      .prepare(
        `
        SELECT
          id, outbox_id, outbound_dedupe_key, channel_id, notifier_type,
          provider_message_id, provider_response_json, sent_at
        FROM sent_log
        WHERE outbound_dedupe_key = ?
        `,
      )
      .bind(outboundDedupeKey)
      .first<SentLogFullRow>();

    return row ? mapSentLog(row) : null;
  }

  private async findSentLogRow(
    outboxId: string,
    outboundDedupeKey: string | null,
  ): Promise<SentLogRow | null> {
    const byOutboxId = await this.db
      .prepare(
        `
        SELECT id, provider_message_id, provider_response_json
        FROM sent_log
        WHERE outbox_id = ?
        `,
      )
      .bind(outboxId)
      .first<SentLogRow>();

    if (byOutboxId) {
      return byOutboxId;
    }

    if (!outboundDedupeKey) {
      return null;
    }

    return this.db
      .prepare(
        `
        SELECT id, provider_message_id, provider_response_json
        FROM sent_log
        WHERE outbound_dedupe_key = ?
        `,
      )
      .bind(outboundDedupeKey)
      .first<SentLogRow>();
  }
}
