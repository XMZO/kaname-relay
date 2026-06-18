export type UnixMs = number;

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'dead' | 'cancelled';

export interface WebhookSourceRecord {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  configJson: string;
  secretJsonEnc: string | null;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ChannelRecord {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  configJson: string;
  secretJsonEnc: string | null;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface RuleRecord {
  id: string;
  sourceId: string | null;
  name: string;
  enabled: boolean;
  priority: number;
  matchJson: string;
  templateJson: string;
  stopOnMatch: boolean;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface RuleChannelRecord {
  ruleId: string;
  channelId: string;
  channelType: string;
  enabled: boolean;
  templateOverrideJson: string | null;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface AppSettingRecord {
  key: string;
  valueJson: string;
  updatedAt: UnixMs;
}

export interface SaveWebhookSourceInput {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  configJson: string;
  secretJsonEnc?: string | null;
  now: UnixMs;
}

export interface PatchWebhookSourceInput {
  id: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  configJson?: string;
  secretJsonEnc?: string | null;
  now: UnixMs;
}

export interface SaveChannelInput {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  configJson: string;
  secretJsonEnc?: string | null;
  now: UnixMs;
}

export interface PatchChannelInput {
  id: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  configJson?: string;
  secretJsonEnc?: string | null;
  now: UnixMs;
}

export interface SaveRuleInput {
  id: string;
  sourceId?: string | null;
  name: string;
  enabled: boolean;
  priority: number;
  matchJson: string;
  templateJson: string;
  stopOnMatch: boolean;
  channelIds: string[];
  now: UnixMs;
}

export interface PatchRuleInput {
  id: string;
  sourceId?: string | null;
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchJson?: string;
  templateJson?: string;
  stopOnMatch?: boolean;
  channelIds?: string[];
  now: UnixMs;
}

export interface DashboardStats {
  receivedLast24h: number;
  outboxByStatus: Record<OutboxStatus, number>;
  recentErrors: OutboxItem[];
}

export interface ListOutboxFilters {
  status?: OutboxStatus;
  sourceId?: string;
  channelId?: string;
  limit?: number;
}

export interface CleanupRetentionInput {
  now: UnixMs;
  sentRetentionMs: number;
  receivedRetentionMs: number;
  limit: number;
}

export interface CleanupRetentionResult {
  sentLogDeleted: number;
  outboxDeleted: number;
  receivedEventsDeleted: number;
}

export interface NewReceivedEvent {
  id: string;
  sourceId: string;
  inboundDedupeKey?: string | null;
  eventType?: string | null;
  payloadHash: string;
}

export interface NewOutboxItem {
  id: string;
  sourceId: string;
  ruleId?: string | null;
  channelId: string;
  notifierType: string;
  priority?: number;
  nextAt: UnixMs;
  attempts?: number;
  maxAttempts?: number;
  inboundDedupeKey?: string | null;
  outboundDedupeKey?: string | null;
  providerIdempotencyKey?: string | null;
  eventType?: string | null;
  payloadJson: string;
  messageJson: string;
  createdAt?: UnixMs;
  updatedAt?: UnixMs;
}

export interface IngestInput {
  receivedEvent: NewReceivedEvent;
  outboxItems: NewOutboxItem[];
  now: UnixMs;
}

export interface IngestResult {
  duplicate: boolean;
  committed: boolean;
  receivedEventId: string;
  seenCount: number;
  outboxCount: number;
}

export interface ClaimDueOutboxInput {
  now: UnixMs;
  leaseId: string;
  leaseUntil: UnixMs;
  limit: number;
}

export interface RecoverExpiredLeasesInput {
  now: UnixMs;
  limit: number;
  backoffDelaysMsByAttempt: Record<number, number>;
  maxBackoffDelayMs: number;
}

export interface RecoverExpiredLeasesResult {
  retried: number;
  dead: number;
}

export interface NewSentLogEntry {
  id?: string;
  outboxId: string;
  outboundDedupeKey?: string | null;
  channelId: string;
  notifierType: string;
  providerMessageId?: string | null;
  providerResponseJson?: string | null;
  sentAt: UnixMs;
  createdAt?: UnixMs;
}

export interface InsertSentLogResult {
  inserted: boolean;
  sentLogId: string;
  providerMessageId?: string;
  providerResponseJson?: string;
}

export interface SentLogEntry {
  id: string;
  outboxId: string | null;
  outboundDedupeKey: string | null;
  channelId: string;
  notifierType: string;
  providerMessageId: string | null;
  providerResponseJson: string | null;
  sentAt: UnixMs;
}

export interface MarkOutboxSentInput {
  id: string;
  leaseId: string;
  now: UnixMs;
  providerMessageId?: string | null;
  providerResponseJson?: string | null;
}

export interface ScheduleOutboxRetryInput {
  id: string;
  leaseId: string;
  now: UnixMs;
  attempts: number;
  nextAt: UnixMs;
  error: string;
}

export interface MarkOutboxDeadInput {
  id: string;
  leaseId: string;
  now: UnixMs;
  attempts: number;
  error: string;
}

export interface CancelOutboxInput {
  id: string;
  leaseId: string;
  now: UnixMs;
  reason: string;
}

export interface OutboxItem {
  id: string;
  sourceId: string;
  receivedEventId: string | null;
  ruleId: string | null;
  channelId: string;
  notifierType: string;
  status: OutboxStatus;
  priority: number;
  nextAt: UnixMs;
  lockedUntil: UnixMs | null;
  leaseId: string | null;
  attempts: number;
  maxAttempts: number;
  inboundDedupeKey: string | null;
  outboundDedupeKey: string | null;
  providerIdempotencyKey: string | null;
  eventType: string | null;
  payloadJson: string;
  messageJson: string;
  lastError: string | null;
  lastErrorAt: UnixMs | null;
  providerMessageId: string | null;
  providerResponseJson: string | null;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  sentAt: UnixMs | null;
  deadAt: UnixMs | null;
  cancelledAt: UnixMs | null;
}
