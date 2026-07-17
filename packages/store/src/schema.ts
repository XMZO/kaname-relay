import { desc, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const webhookSources = sqliteTable(
  'webhook_sources',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    type: text('type').notNull(),
    enabled: integer('enabled').notNull().default(1),
    configJson: text('config_json').notNull().default('{}'),
    secretJsonEnc: text('secret_json_enc'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('webhook_sources_enabled_bool', sql`${table.enabled} IN (0, 1)`),
    uniqueIndex('idx_webhook_sources_id_nocase').on(sql`${table.id} COLLATE NOCASE`),
    index('idx_webhook_sources_type_enabled').on(table.type, table.enabled),
  ],
);

export const channels = sqliteTable(
  'channels',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    type: text('type').notNull(),
    enabled: integer('enabled').notNull().default(1),
    configJson: text('config_json').notNull().default('{}'),
    secretJsonEnc: text('secret_json_enc'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('channels_enabled_bool', sql`${table.enabled} IN (0, 1)`),
    index('idx_channels_type_enabled').on(table.type, table.enabled),
  ],
);

export const notificationTemplates = sqliteTable(
  'notification_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    templateJson: text('template_json').notNull().default('{}'),
    samplePayloadJson: text('sample_payload_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_notification_templates_updated').on(desc(table.updatedAt))],
);

export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').references(() => webhookSources.id, { onDelete: 'cascade' }),
    templateId: text('template_id').references(() => notificationTemplates.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    enabled: integer('enabled').notNull().default(1),
    priority: integer('priority').notNull().default(0),
    matchJson: text('match_json').notNull().default('{}'),
    templateJson: text('template_json').notNull().default('{}'),
    stopOnMatch: integer('stop_on_match').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('rules_enabled_bool', sql`${table.enabled} IN (0, 1)`),
    check('rules_stop_on_match_bool', sql`${table.stopOnMatch} IN (0, 1)`),
    index('idx_rules_source_enabled_priority').on(
      table.sourceId,
      table.enabled,
      desc(table.priority),
    ),
    index('idx_rules_enabled_priority').on(table.enabled, desc(table.priority)),
    index('idx_rules_template_id').on(table.templateId),
  ],
);

export const ruleChannels = sqliteTable(
  'rule_channels',
  {
    ruleId: text('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    enabled: integer('enabled').notNull().default(1),
    templateOverrideJson: text('template_override_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ruleId, table.channelId] }),
    check('rule_channels_enabled_bool', sql`${table.enabled} IN (0, 1)`),
    index('idx_rule_channels_channel_enabled').on(table.channelId, table.enabled),
  ],
);

export const receivedEvents = sqliteTable(
  'received_events',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => webhookSources.id, { onDelete: 'cascade' }),
    inboundDedupeKey: text('inbound_dedupe_key'),
    eventType: text('event_type'),
    payloadHash: text('payload_hash').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    seenCount: integer('seen_count').notNull().default(1),
    lastOutboxCount: integer('last_outbox_count').notNull().default(0),
    committed: integer('committed').notNull().default(0),
  },
  (table) => [
    check('received_events_committed_bool', sql`${table.committed} IN (0, 1)`),
    uniqueIndex('idx_received_events_source_dedupe')
      .on(table.sourceId, table.inboundDedupeKey)
      .where(sql`${table.inboundDedupeKey} IS NOT NULL`),
    index('idx_received_events_seen').on(table.sourceId, desc(table.lastSeenAt)),
    index('idx_received_events_payload_hash').on(table.sourceId, table.payloadHash),
  ],
);

export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => webhookSources.id, { onDelete: 'cascade' }),
    receivedEventId: text('received_event_id').references(() => receivedEvents.id, {
      onDelete: 'set null',
    }),
    ruleId: text('rule_id').references(() => rules.id, { onDelete: 'set null' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    notifierType: text('notifier_type').notNull(),
    status: text('status').notNull().default('pending'),
    priority: integer('priority').notNull().default(0),
    nextAt: integer('next_at').notNull(),
    lockedUntil: integer('locked_until'),
    leaseId: text('lease_id'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    inboundDedupeKey: text('inbound_dedupe_key'),
    outboundDedupeKey: text('outbound_dedupe_key'),
    providerIdempotencyKey: text('provider_idempotency_key'),
    eventType: text('event_type'),
    payloadJson: text('payload_json').notNull(),
    messageJson: text('message_json').notNull(),
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at'),
    providerMessageId: text('provider_message_id'),
    providerResponseJson: text('provider_response_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    sentAt: integer('sent_at'),
    deadAt: integer('dead_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (table) => [
    check(
      'outbox_status_check',
      sql`${table.status} IN ('pending', 'sending', 'sent', 'dead', 'cancelled')`,
    ),
    uniqueIndex('idx_outbox_outbound_dedupe')
      .on(table.outboundDedupeKey)
      .where(sql`${table.outboundDedupeKey} IS NOT NULL`),
    index('idx_outbox_due').on(table.status, table.nextAt, desc(table.priority), table.createdAt),
    index('idx_outbox_lease_expired').on(table.status, table.lockedUntil),
    index('idx_outbox_channel_status').on(table.channelId, table.status, desc(table.createdAt)),
    index('idx_outbox_source_created').on(table.sourceId, desc(table.createdAt)),
  ],
);

export const sentLog = sqliteTable(
  'sent_log',
  {
    id: text('id').primaryKey(),
    outboxId: text('outbox_id').references(() => outbox.id, { onDelete: 'set null' }),
    outboundDedupeKey: text('outbound_dedupe_key'),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    notifierType: text('notifier_type').notNull(),
    providerMessageId: text('provider_message_id'),
    providerResponseJson: text('provider_response_json'),
    sentAt: integer('sent_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_sent_log_outbox')
      .on(table.outboxId)
      .where(sql`${table.outboxId} IS NOT NULL`),
    uniqueIndex('idx_sent_log_outbound_dedupe')
      .on(table.outboundDedupeKey)
      .where(sql`${table.outboundDedupeKey} IS NOT NULL`),
    index('idx_sent_log_channel_sent').on(table.channelId, desc(table.sentAt)),
  ],
);

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
