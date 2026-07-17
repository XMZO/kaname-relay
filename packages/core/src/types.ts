export type UnixMs = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Logger {
  error?(message: string, context?: JsonObject): void;
  warn?(message: string, context?: JsonObject): void;
  info?(message: string, context?: JsonObject): void;
}

export interface ChannelConfig {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: JsonObject;
  secrets: JsonObject;
}

export type NotificationImageFormat = 'png' | 'jpeg' | 'webp';
export type NotificationImageDelivery = 'attachment' | 'replace-text' | 'text-and-image';

export interface NotificationRenderRequest {
  renderer: string;
  html: string;
  format?: NotificationImageFormat;
  filename?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  quality?: number;
  fullPage?: boolean;
  selector?: string;
  background?: string;
  delivery?: NotificationImageDelivery;
  options?: JsonObject;
}

export interface NotificationAsset {
  filename: string;
  contentType: string;
  data: Uint8Array;
  altText?: string;
}

export interface NotificationRenderContext {
  now: () => UnixMs;
  signal: AbortSignal;
  logger?: Logger;
}

export interface NotificationRenderer {
  type: string;
  render(
    request: NotificationRenderRequest,
    context: NotificationRenderContext,
  ): Promise<NotificationAsset[]>;
}

export interface NotificationMessage {
  title?: string;
  text: string;
  html?: string;
  markdown?: string;
  tags?: string[];
  metadata?: JsonObject;
  render?: NotificationRenderRequest;
}

export interface NotifierSendContext {
  channel: ChannelConfig;
  idempotencyKey: string;
  now: () => UnixMs;
  signal: AbortSignal;
  logger?: Logger;
  assets?: readonly NotificationAsset[];
}

export interface NotifierResult {
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
}

export interface NotifierError extends Error {
  retryable: boolean;
  statusCode?: number;
  providerCode?: string;
}

export interface Notifier {
  type: string;
  send(message: NotificationMessage, context: NotifierSendContext): Promise<NotifierResult>;
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'dead' | 'cancelled';

export interface OutboxItem {
  id: string;
  sourceId: string;
  receivedEventId?: string | null;
  ruleId?: string | null;
  channelId: string;
  notifierType: string;
  status: OutboxStatus;
  priority: number;
  nextAt: UnixMs;
  lockedUntil?: UnixMs | null;
  leaseId?: string | null;
  attempts: number;
  maxAttempts: number;
  inboundDedupeKey?: string | null;
  outboundDedupeKey?: string | null;
  providerIdempotencyKey?: string | null;
  eventType?: string | null;
  message: NotificationMessage;
}

export interface SentLogEntry {
  id: string;
  outboxId?: string | null;
  outboundDedupeKey?: string | null;
  channelId: string;
  notifierType: string;
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
  sentAt: UnixMs;
}

export interface NewSentLogEntry {
  outboxId: string;
  outboundDedupeKey?: string | null;
  channelId: string;
  notifierType: string;
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
  sentAt: UnixMs;
}

export interface InsertSentLogResult {
  inserted: boolean;
  sentLogId: string;
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
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

export interface ClaimDueOutboxInput {
  now: UnixMs;
  leaseId: string;
  leaseUntil: UnixMs;
  limit: number;
}

export interface MarkOutboxSentInput {
  id: string;
  leaseId: string;
  now: UnixMs;
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
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

export interface ProcessPendingStore {
  recoverExpiredLeases(input: RecoverExpiredLeasesInput): Promise<RecoverExpiredLeasesResult>;
  claimDueOutbox(input: ClaimDueOutboxInput): Promise<OutboxItem[]>;
  getEnabledChannel(id: string): Promise<ChannelConfig | null>;
  findSentLogByDedupeKey(outboundDedupeKey: string): Promise<SentLogEntry | null>;
  insertSentLog(input: NewSentLogEntry): Promise<InsertSentLogResult>;
  markOutboxSentByLease(input: MarkOutboxSentInput): Promise<boolean>;
  scheduleOutboxRetryByLease(input: ScheduleOutboxRetryInput): Promise<boolean>;
  markOutboxDeadByLease(input: MarkOutboxDeadInput): Promise<boolean>;
  cancelOutboxByLease(input: CancelOutboxInput): Promise<boolean>;
}

export interface BackoffConfig {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitterRatio?: number;
}

export interface ProcessPendingArgs {
  store: ProcessPendingStore;
  notifiers: Record<string, Notifier | undefined>;
  now: () => UnixMs;
  idGenerator: () => string;
  limit: number;
  recoverLimit: number;
  leaseMs: number;
  sendTimeoutMs: number;
  maxConcurrency: number;
  backoff: BackoffConfig;
  random?: () => number;
  logger?: Logger;
}

export interface ProcessPendingResult {
  recovered: RecoverExpiredLeasesResult;
  claimed: number;
  sent: number;
  deduped: number;
  retried: number;
  dead: number;
  cancelled: number;
  leaseLost: number;
  errored: number;
}
