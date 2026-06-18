import type {
  ChannelConfig,
  CancelOutboxInput as CoreCancelOutboxInput,
  InsertSentLogResult as CoreInsertSentLogResult,
  JsonObject,
  JsonValue,
  MarkOutboxDeadInput as CoreMarkOutboxDeadInput,
  MarkOutboxSentInput as CoreMarkOutboxSentInput,
  NewSentLogEntry as CoreNewSentLogEntry,
  OutboxItem as CoreOutboxItem,
  ProcessPendingStore,
  RecoverExpiredLeasesInput as CoreRecoverExpiredLeasesInput,
  RecoverExpiredLeasesResult as CoreRecoverExpiredLeasesResult,
  ScheduleOutboxRetryInput as CoreScheduleOutboxRetryInput,
  SentLogEntry as CoreSentLogEntry,
} from '@kaname-relay/core';

import type { D1Store } from './d1-store.js';
import type { SqliteStore } from './sqlite-store.js';
import type {
  CancelOutboxInput,
  ChannelRecord,
  ClaimDueOutboxInput,
  InsertSentLogResult,
  MarkOutboxDeadInput,
  MarkOutboxSentInput,
  NewSentLogEntry,
  OutboxItem,
  RecoverExpiredLeasesInput,
  RecoverExpiredLeasesResult,
  ScheduleOutboxRetryInput,
  SentLogEntry,
} from './types.js';

export interface ProcessPendingStoreAdapterOptions {
  decryptSecrets?: (
    secretJsonEnc: string | null,
    channelId: string,
  ) => JsonObject | Promise<JsonObject>;
  logger?: {
    warn?(message: string, context?: JsonObject): void;
  };
}

export type SqliteProcessPendingStoreOptions = ProcessPendingStoreAdapterOptions;
export type D1ProcessPendingStoreOptions = ProcessPendingStoreAdapterOptions;

interface ProcessPendingBackingStore {
  recoverExpiredLeases(input: RecoverExpiredLeasesInput): Promise<RecoverExpiredLeasesResult>;
  claimDueOutbox(input: ClaimDueOutboxInput): Promise<OutboxItem[]>;
  getEnabledChannelRecord(id: string): Promise<ChannelRecord | null>;
  findSentLogByDedupeKey(outboundDedupeKey: string): Promise<SentLogEntry | null>;
  insertSentLog(input: NewSentLogEntry): Promise<InsertSentLogResult>;
  markOutboxSentByLease(input: MarkOutboxSentInput): Promise<boolean>;
  scheduleOutboxRetryByLease(input: ScheduleOutboxRetryInput): Promise<boolean>;
  markOutboxDeadByLease(input: MarkOutboxDeadInput): Promise<boolean>;
  cancelOutboxByLease(input: CancelOutboxInput): Promise<boolean>;
}

export class StoreProcessPendingAdapter implements ProcessPendingStore {
  public constructor(
    private readonly store: ProcessPendingBackingStore,
    private readonly options: ProcessPendingStoreAdapterOptions = {},
  ) {}

  public recoverExpiredLeases(
    input: CoreRecoverExpiredLeasesInput,
  ): Promise<CoreRecoverExpiredLeasesResult> {
    return this.store.recoverExpiredLeases(input);
  }

  public async claimDueOutbox(input: ClaimDueOutboxInput): Promise<CoreOutboxItem[]> {
    const claimed = await this.store.claimDueOutbox(input);
    const valid: CoreOutboxItem[] = [];

    for (const item of claimed) {
      const message = parseNotificationMessage(item.messageJson);

      if (!message.ok) {
        const error = `invalid message_json: ${message.error}`;
        const marked = await this.store.markOutboxDeadByLease({
          id: item.id,
          leaseId: input.leaseId,
          now: input.now,
          attempts: item.attempts + 1,
          error,
        });

        this.options.logger?.warn?.('dead-lettered outbox with invalid message_json', {
          outboxId: item.id,
          marked,
          error,
        });
        continue;
      }

      valid.push(mapOutboxForCore(item, message.value));
    }

    return valid;
  }

  public async getEnabledChannel(id: string): Promise<ChannelConfig | null> {
    const row = await this.store.getEnabledChannelRecord(id);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled,
      config: parseJsonObject(row.configJson, `channels.config_json:${row.id}`),
      secrets: await this.decryptSecrets(row.secretJsonEnc, row.id),
    };
  }

  public async findSentLogByDedupeKey(outboundDedupeKey: string): Promise<CoreSentLogEntry | null> {
    const entry = await this.store.findSentLogByDedupeKey(outboundDedupeKey);

    if (!entry) {
      return null;
    }

    const mapped: CoreSentLogEntry = {
      id: entry.id,
      outboxId: entry.outboxId,
      outboundDedupeKey: entry.outboundDedupeKey,
      channelId: entry.channelId,
      notifierType: entry.notifierType,
      sentAt: entry.sentAt,
    };

    if (entry.providerMessageId !== null) {
      mapped.providerMessageId = entry.providerMessageId;
    }

    if (entry.providerResponseJson !== null) {
      mapped.providerResponseJson = parseJsonObject(
        entry.providerResponseJson,
        `sent_log.provider_response_json:${entry.id}`,
      );
    }

    return mapped;
  }

  public async insertSentLog(input: CoreNewSentLogEntry): Promise<CoreInsertSentLogResult> {
    const entry: NewSentLogEntry = {
      outboxId: input.outboxId,
      channelId: input.channelId,
      notifierType: input.notifierType,
      sentAt: input.sentAt,
    };

    if (input.outboundDedupeKey !== undefined) {
      entry.outboundDedupeKey = input.outboundDedupeKey;
    }

    if (input.providerMessageId !== undefined) {
      entry.providerMessageId = input.providerMessageId;
    }

    if (input.providerResponseJson !== undefined) {
      entry.providerResponseJson = JSON.stringify(input.providerResponseJson);
    }

    const result = await this.store.insertSentLog(entry);
    const mapped: CoreInsertSentLogResult = {
      inserted: result.inserted,
      sentLogId: result.sentLogId,
    };

    if (result.providerMessageId !== undefined) {
      mapped.providerMessageId = result.providerMessageId;
    }

    if (result.providerResponseJson !== undefined) {
      mapped.providerResponseJson = parseJsonObject(
        result.providerResponseJson,
        `sent_log.provider_response_json:${result.sentLogId}`,
      );
    }

    return mapped;
  }

  public markOutboxSentByLease(input: CoreMarkOutboxSentInput): Promise<boolean> {
    const providerResponseJson =
      typeof input.providerResponseJson === 'object' && input.providerResponseJson !== null
        ? JSON.stringify(input.providerResponseJson)
        : null;

    return this.store.markOutboxSentByLease({
      id: input.id,
      leaseId: input.leaseId,
      now: input.now,
      providerMessageId: input.providerMessageId ?? null,
      providerResponseJson,
    });
  }

  public scheduleOutboxRetryByLease(input: CoreScheduleOutboxRetryInput): Promise<boolean> {
    return this.store.scheduleOutboxRetryByLease(input);
  }

  public markOutboxDeadByLease(input: CoreMarkOutboxDeadInput): Promise<boolean> {
    return this.store.markOutboxDeadByLease(input);
  }

  public cancelOutboxByLease(input: CoreCancelOutboxInput): Promise<boolean> {
    return this.store.cancelOutboxByLease(input);
  }

  private async decryptSecrets(
    secretJsonEnc: string | null,
    channelId: string,
  ): Promise<JsonObject> {
    if (this.options.decryptSecrets) {
      return this.options.decryptSecrets(secretJsonEnc, channelId);
    }

    if (!secretJsonEnc) {
      return {};
    }

    this.options.logger?.warn?.(
      'using plaintext channel secrets because no decryptSecrets option was provided',
      {
        channelId,
      },
    );

    return parseJsonObject(secretJsonEnc, `channels.secret_json_enc:${channelId}`);
  }
}

export class SqliteProcessPendingStore extends StoreProcessPendingAdapter {
  public constructor(store: SqliteStore, options: SqliteProcessPendingStoreOptions = {}) {
    super(store, options);
  }
}

export class D1ProcessPendingStore extends StoreProcessPendingAdapter {
  public constructor(store: D1Store, options: D1ProcessPendingStoreOptions = {}) {
    super(store, options);
  }
}

function mapOutboxForCore(item: OutboxItem, message: CoreOutboxItem['message']): CoreOutboxItem {
  return {
    id: item.id,
    sourceId: item.sourceId,
    receivedEventId: item.receivedEventId,
    ruleId: item.ruleId,
    channelId: item.channelId,
    notifierType: item.notifierType,
    status: item.status,
    priority: item.priority,
    nextAt: item.nextAt,
    lockedUntil: item.lockedUntil,
    leaseId: item.leaseId,
    attempts: item.attempts,
    maxAttempts: item.maxAttempts,
    inboundDedupeKey: item.inboundDedupeKey,
    outboundDedupeKey: item.outboundDedupeKey,
    providerIdempotencyKey: item.providerIdempotencyKey,
    eventType: item.eventType,
    message,
  };
}

function parseNotificationMessage(
  json: string,
): { ok: true; value: CoreOutboxItem['message'] } | { ok: false; error: string } {
  let value: JsonValue;

  try {
    value = JSON.parse(json) as JsonValue;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'invalid JSON',
    };
  }

  if (!isJsonObject(value)) {
    return { ok: false, error: 'expected a JSON object' };
  }

  if (typeof value.text !== 'string' || value.text.length === 0) {
    return { ok: false, error: 'expected non-empty string field "text"' };
  }

  return {
    ok: true,
    value: notificationMessageFromObject(value),
  };
}

function notificationMessageFromObject(value: JsonObject): CoreOutboxItem['message'] {
  const message: CoreOutboxItem['message'] = {
    text: String(value.text),
  };

  if (typeof value.title === 'string') {
    message.title = value.title;
  }

  if (typeof value.html === 'string') {
    message.html = value.html;
  }

  if (typeof value.markdown === 'string') {
    message.markdown = value.markdown;
  }

  if (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string')) {
    message.tags = value.tags;
  }

  if (isJsonObject(value.metadata)) {
    message.metadata = value.metadata;
  }

  return message;
}

function parseJsonObject(json: string, label: string): JsonObject {
  const value = JSON.parse(json) as JsonValue;

  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
