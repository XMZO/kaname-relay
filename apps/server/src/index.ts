import {
  createAesGcmSecretCodec,
  isSupportedSourceType,
  matchesRule,
  parseSecretJson,
  parseWebhookSourceEvent,
  processPending,
  renderNotificationMessage,
  verifyWebhookSignature,
  type JsonObject,
  type JsonValue,
  type Logger,
  type Notifier,
  type ProcessPendingArgs,
  type ProcessPendingResult,
  type SecretCodec,
} from '@kaname-relay/core';
import {
  createResendNotifier,
  createTelegramNotifier,
  createWebhookNotifier,
} from '@kaname-relay/notifiers';
import { createSmtpNotifier } from '@kaname-relay/notifiers/smtp.node';
import {
  applySqliteMigrations,
  SqliteProcessPendingStore,
  SqliteStore,
  type NewOutboxItem,
  type RuleRecord,
} from '@kaname-relay/store';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AdminHttpError,
  mountAdminRoutes,
  RETENTION_SETTING,
  RETRY_SETTING,
  type AdminRoutesOptions,
} from './admin.js';

export interface ServerAppOptions {
  store: SqliteStore;
  now?: () => number;
  idGenerator?: () => string;
  maxBodyBytes?: number;
  maxAttempts?: number;
  notifiers?: Record<string, Notifier | undefined>;
  webDir?: string | null;
  triggerProcessing?: () => void | Promise<void>;
  logger?: Logger;
  secretCodec?: SecretCodec;
  rateLimit?: RateLimitConfig | false;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface RetentionConfig {
  sentRetentionMs: number;
  receivedRetentionMs: number;
  limit: number;
  intervalMs: number;
}

export interface ProcessSchedulerOptions {
  store: SqliteProcessPendingStore;
  notifiers: Record<string, Notifier | undefined>;
  now?: () => number;
  idGenerator?: () => string;
  logger?: Logger;
  intervalMs?: number;
  limit?: number;
  recoverLimit?: number;
  leaseMs?: number;
  sendTimeoutMs?: number;
  maxConcurrency?: number;
  loadRetrySettings?: () => Promise<Partial<RetrySettings>>;
}

export interface RetrySettings {
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitterRatio: number;
  leaseMs: number;
  sendTimeoutMs: number;
}

export interface ProcessScheduler {
  tick(): Promise<ProcessPendingResult | null>;
  start(): void;
  stop(): void;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  max: 120,
};
const DEFAULT_RETENTION: RetentionConfig = {
  sentRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  receivedRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  limit: 100,
  intervalMs: 60 * 60 * 1_000,
};
const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  maxAttempts: 10,
  initialDelayMs: 30_000,
  multiplier: 2,
  maxDelayMs: 1_800_000,
  jitterRatio: 0.2,
  leaseMs: 90_000,
  sendTimeoutMs: 15_000,
};

export function createServerApp(options: ServerAppOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const rateLimiter =
    options.rateLimit === false
      ? null
      : createMemoryRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);

  app.onError((error, context) => {
    if (error instanceof AdminHttpError) {
      return context.json({ error: error.message }, error.status);
    }

    options.logger?.error?.('request failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });

    return context.json({ error: 'internal server error' }, 500);
  });

  app.get('/healthz', (context) => context.json({ ok: true }));

  const adminOptions: AdminRoutesOptions = {
    store: options.store,
    now,
    idGenerator,
    notifiers: options.notifiers ?? {},
  };

  if (options.triggerProcessing !== undefined) {
    adminOptions.triggerProcessing = options.triggerProcessing;
  }

  if (options.logger !== undefined) {
    adminOptions.logger = options.logger;
  }

  if (options.secretCodec !== undefined) {
    adminOptions.secretCodec = options.secretCodec;
  }

  mountAdminRoutes(app, adminOptions);

  app.post('/hooks/:sourceId', async (context) => {
    const sourceId = context.req.param('sourceId');
    const rateKey = `${sourceId.toLowerCase()}:${clientIp(context.req.raw.headers)}`;

    if (rateLimiter && !rateLimiter.allow(rateKey, now())) {
      return context.json({ error: 'rate limit exceeded' }, 429);
    }

    const source = await options.store.getEnabledSource(sourceId);

    if (!source) {
      return context.json({ error: 'source not found or disabled' }, 404);
    }

    if (!isSupportedSourceType(source.type)) {
      return context.json({ error: `unsupported source type: ${source.type}` }, 400);
    }

    const rawBody = await context.req.text();

    if (byteLength(rawBody) > maxBodyBytes) {
      return context.json({ error: 'payload too large' }, 413);
    }

    const sourceConfig = parseStoredJsonObject(source.configJson, `source config ${source.id}`);
    const sourceSecrets = await decryptSecretJson(source.secretJsonEnc, source.id, options);
    const verified = await verifyWebhookSignature({
      rawBody,
      headers: context.req.raw.headers,
      config: sourceConfig,
      secrets: sourceSecrets,
    });

    if (!verified) {
      return context.json({ error: 'invalid webhook signature' }, 401);
    }

    const payloadResult = parseJsonObject(rawBody);

    if (!payloadResult.ok) {
      return context.json({ error: payloadResult.error }, 400);
    }

    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const parsedEvent = parseWebhookSourceEvent({
      sourceType: source.type,
      payload: payloadResult.value,
      config: sourceConfig,
      payloadHash,
    });
    const receivedEventId = idGenerator();
    const rules = await options.store.listEnabledRulesForSource(source.id);
    const outboxItems = await buildOutboxItems({
      store: options.store,
      rules,
      sourceId: source.id,
      payload: parsedEvent.payload,
      payloadJson: rawBody,
      inboundDedupeKey: parsedEvent.inboundDedupeKey,
      eventType: parsedEvent.eventType,
      now: now(),
      maxAttempts: await configuredMaxAttempts(options.store, maxAttempts),
      idGenerator,
    });

    const ingestResult = await options.store.ingest({
      now: now(),
      receivedEvent: {
        id: receivedEventId,
        sourceId: source.id,
        inboundDedupeKey: parsedEvent.inboundDedupeKey,
        eventType: parsedEvent.eventType,
        payloadHash,
      },
      outboxItems,
    });

    if (!ingestResult.duplicate && ingestResult.outboxCount > 0) {
      void Promise.resolve(options.triggerProcessing?.()).catch((error: unknown) => {
        options.logger?.error?.('webhook-triggered processing failed', {
          error: error instanceof Error ? error.message : 'unknown error',
        });
      });
    }

    return context.json(
      {
        accepted: true,
        duplicate: ingestResult.duplicate,
        receivedEventId: ingestResult.receivedEventId,
        seenCount: ingestResult.seenCount,
        outboxCount: ingestResult.outboxCount,
      },
      202,
    );
  });

  mountStaticWebUi(app, options.webDir);

  return app;
}

export function createProcessScheduler(options: ProcessSchedulerOptions): ProcessScheduler {
  const now = options.now ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  const intervalMs = options.intervalMs ?? 2_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<ProcessPendingResult> | null = null;

  async function tick(): Promise<ProcessPendingResult | null> {
    if (running) {
      return null;
    }

    const retrySettings = {
      ...DEFAULT_RETRY_SETTINGS,
      ...(options.loadRetrySettings ? await options.loadRetrySettings() : {}),
    };
    const processArgs: ProcessPendingArgs = {
      store: options.store,
      notifiers: options.notifiers,
      now,
      idGenerator,
      limit: options.limit ?? 25,
      recoverLimit: options.recoverLimit ?? 50,
      leaseMs: options.leaseMs ?? retrySettings.leaseMs,
      sendTimeoutMs: options.sendTimeoutMs ?? retrySettings.sendTimeoutMs,
      maxConcurrency: options.maxConcurrency ?? 4,
      backoff: {
        initialDelayMs: retrySettings.initialDelayMs,
        multiplier: retrySettings.multiplier,
        maxDelayMs: retrySettings.maxDelayMs,
        jitterRatio: retrySettings.jitterRatio,
      },
    };

    if (options.logger !== undefined) {
      processArgs.logger = options.logger;
    }

    running = processPending(processArgs).finally(() => {
      running = null;
    });

    return running;
  }

  return {
    tick,
    start() {
      if (timer) {
        return;
      }

      timer = setInterval(() => {
        void tick().catch((error: unknown) => {
          options.logger?.error?.('scheduled processing failed', {
            error: error instanceof Error ? error.message : 'unknown error',
          });
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export function createNodeRuntime(
  options: {
    databasePath?: string;
    port?: number;
    webDir?: string | null;
    logger?: Logger;
    retention?: RetentionConfig | false;
  } = {},
): {
  app: Hono;
  db: Database.Database;
  store: SqliteStore;
  scheduler: ProcessScheduler;
  start(): void;
  stop(): void;
} {
  const databasePath = options.databasePath ?? defaultDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  applySqliteMigrations(db, runtimeMigrationsDir());

  const store = new SqliteStore(db);
  const secretCodec = secretCodecFromRuntime(databasePath);
  const notifiers = {
    resend: createResendNotifier(),
    smtp: createSmtpNotifier(),
    telegram: createTelegramNotifier(),
    webhook: createWebhookNotifier(),
  };
  const processStore = new SqliteProcessPendingStore(store, {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    decryptSecrets: (secretJsonEnc: string | null) => secretCodec.decrypt(secretJsonEnc),
  });
  const schedulerOptions: ProcessSchedulerOptions = {
    store: processStore,
    notifiers,
    loadRetrySettings: async () => configuredRetrySettings(store),
  };

  if (options.logger !== undefined) {
    schedulerOptions.logger = options.logger;
  }

  const scheduler = createProcessScheduler(schedulerOptions);
  const appOptions: ServerAppOptions = {
    store,
    notifiers,
    webDir: options.webDir === undefined ? defaultWebDir() : options.webDir,
    triggerProcessing: async () => {
      await scheduler.tick();
    },
  };

  if (options.logger !== undefined) {
    appOptions.logger = options.logger;
  }

  appOptions.secretCodec = secretCodec;

  const app = createServerApp(appOptions);
  let server: ReturnType<typeof serve> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  async function cleanupTick(): Promise<void> {
    if (options.retention === false) {
      return;
    }

    const retention = await configuredRetention(store, options.retention ?? DEFAULT_RETENTION);
    await store.cleanupRetention({
      now: Date.now(),
      sentRetentionMs: retention.sentRetentionMs,
      receivedRetentionMs: retention.receivedRetentionMs,
      limit: retention.limit,
    });
  }

  return {
    app,
    db,
    store,
    scheduler,
    start() {
      scheduler.start();
      if (options.retention !== false && cleanupTimer === undefined) {
        const retention = options.retention ?? DEFAULT_RETENTION;
        cleanupTimer = setInterval(() => {
          void cleanupTick().catch((error: unknown) => {
            options.logger?.error?.('retention cleanup failed', {
              error: error instanceof Error ? error.message : 'unknown error',
            });
          });
        }, retention.intervalMs);
        cleanupTimer.unref?.();
      }
      server = serve({
        fetch: app.fetch,
        hostname: process.env.HOST ?? '0.0.0.0',
        port: options.port ?? numberFromEnv(process.env.PORT) ?? 3000,
      });
    },
    stop() {
      scheduler.stop();
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = undefined;
      }
      server?.close();
      db.close();
    },
  };
}

function mountStaticWebUi(app: Hono, webDir: string | null | undefined): void {
  if (!webDir || !existsSync(webDir)) {
    return;
  }

  app.get('/assets/*', serveStatic({ root: webDir }));
  app.get('/', serveStatic({ root: webDir, path: 'index.html' }));
}

interface BuildOutboxInput {
  store: SqliteStore;
  rules: RuleRecord[];
  sourceId: string;
  payload: JsonObject;
  payloadJson: string;
  inboundDedupeKey: string | null;
  eventType: string | null;
  now: number;
  maxAttempts: number;
  idGenerator: () => string;
}

async function buildOutboxItems(input: BuildOutboxInput): Promise<NewOutboxItem[]> {
  const outboxItems: NewOutboxItem[] = [];

  for (const rule of input.rules) {
    const match = parseStoredJson(rule.matchJson, `rule match ${rule.id}`);

    if (!matchesRule(match, input.payload)) {
      continue;
    }

    const channels = await input.store.listEnabledRuleChannels(rule.id);
    const ruleTemplateJson = await resolveRuleTemplateJson(input.store, rule);

    for (const channel of channels) {
      const templateJson = channel.templateOverrideJson ?? ruleTemplateJson;
      const template = parseStoredJson(templateJson, `rule template ${rule.id}`);
      const message = renderNotificationMessage({
        template,
        payload: input.payload,
        sourceId: input.sourceId,
        eventType: input.eventType,
        ruleId: rule.id,
        channelId: channel.channelId,
        now: input.now,
      });
      const outboundDedupeKey = input.inboundDedupeKey
        ? `${input.sourceId}:${input.inboundDedupeKey}:${rule.id}:${channel.channelId}`
        : null;

      outboxItems.push({
        id: input.idGenerator(),
        sourceId: input.sourceId,
        ruleId: rule.id,
        channelId: channel.channelId,
        notifierType: channel.channelType,
        priority: rule.priority,
        nextAt: input.now,
        attempts: 0,
        maxAttempts: input.maxAttempts,
        inboundDedupeKey: input.inboundDedupeKey,
        outboundDedupeKey,
        providerIdempotencyKey: outboundDedupeKey,
        eventType: input.eventType,
        payloadJson: input.payloadJson,
        messageJson: JSON.stringify(message),
        createdAt: input.now,
        updatedAt: input.now,
      });
    }

    if (rule.stopOnMatch) {
      break;
    }
  }

  return outboxItems;
}

async function resolveRuleTemplateJson(store: SqliteStore, rule: RuleRecord): Promise<string> {
  if (!rule.templateId) {
    return rule.templateJson;
  }

  const template = await store.getNotificationTemplate(rule.templateId);

  return template?.templateJson ?? rule.templateJson;
}

function parseJsonObject(
  rawBody: string,
): { ok: true; value: JsonObject } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawBody) as JsonValue;

    if (!isJsonObject(parsed)) {
      return { ok: false, error: 'payload must be a JSON object' };
    }

    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'payload must be valid JSON' };
  }
}

function parseStoredJson(raw: string, label: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(
      `${label} contains invalid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
      {
        cause: error,
      },
    );
  }
}

function parseStoredJsonObject(raw: string, label: string): JsonObject {
  const parsed = parseStoredJson(raw, label);

  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return parsed;
}

async function configuredMaxAttempts(store: SqliteStore, fallback: number): Promise<number> {
  const retrySettings = await configuredRetrySettings(store);

  return retrySettings.maxAttempts ?? fallback;
}

async function configuredRetrySettings(store: SqliteStore): Promise<Partial<RetrySettings>> {
  const setting = await store.getSetting(RETRY_SETTING);

  if (!setting) {
    return {};
  }

  const parsed = parseStoredJsonObject(setting.valueJson, RETRY_SETTING);

  return {
    maxAttempts: positiveIntegerSetting(
      parsed.maxAttempts,
      DEFAULT_RETRY_SETTINGS.maxAttempts,
      'retry.maxAttempts',
    ),
    initialDelayMs: positiveIntegerSetting(
      parsed.initialDelayMs,
      DEFAULT_RETRY_SETTINGS.initialDelayMs,
      'retry.initialDelayMs',
    ),
    multiplier: positiveNumberSetting(
      parsed.multiplier,
      DEFAULT_RETRY_SETTINGS.multiplier,
      'retry.multiplier',
    ),
    maxDelayMs: positiveIntegerSetting(
      parsed.maxDelayMs,
      DEFAULT_RETRY_SETTINGS.maxDelayMs,
      'retry.maxDelayMs',
    ),
    jitterRatio: nonNegativeNumberSetting(
      parsed.jitterRatio,
      DEFAULT_RETRY_SETTINGS.jitterRatio,
      'retry.jitterRatio',
    ),
    leaseMs: positiveIntegerSetting(
      parsed.leaseMs,
      DEFAULT_RETRY_SETTINGS.leaseMs,
      'retry.leaseMs',
    ),
    sendTimeoutMs: positiveIntegerSetting(
      parsed.sendTimeoutMs,
      DEFAULT_RETRY_SETTINGS.sendTimeoutMs,
      'retry.sendTimeoutMs',
    ),
  };
}

async function configuredRetention(
  store: SqliteStore,
  fallback: RetentionConfig,
): Promise<RetentionConfig> {
  const setting = await store.getSetting(RETENTION_SETTING);

  if (!setting) {
    return fallback;
  }

  const parsed = parseStoredJsonObject(setting.valueJson, RETENTION_SETTING);
  const dayMs = 24 * 60 * 60 * 1_000;

  return {
    sentRetentionMs:
      positiveIntegerSetting(
        parsed.sentRetentionDays,
        Math.max(1, Math.ceil(fallback.sentRetentionMs / dayMs)),
        'retention.sentRetentionDays',
      ) * dayMs,
    receivedRetentionMs:
      positiveIntegerSetting(
        parsed.receivedRetentionDays,
        Math.max(1, Math.ceil(fallback.receivedRetentionMs / dayMs)),
        'retention.receivedRetentionDays',
      ) * dayMs,
    limit: positiveIntegerSetting(parsed.cleanupLimit, fallback.limit, 'retention.cleanupLimit'),
    intervalMs: fallback.intervalMs,
  };
}

function positiveIntegerSetting(
  value: JsonValue | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function positiveNumberSetting(
  value: JsonValue | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return value;
}

function nonNegativeNumberSetting(
  value: JsonValue | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }

  return value;
}

async function decryptSecretJson(
  secretJsonEnc: string | null,
  ownerId: string,
  options: Pick<ServerAppOptions, 'logger' | 'secretCodec'>,
): Promise<JsonObject> {
  if (options.secretCodec) {
    return options.secretCodec.decrypt(secretJsonEnc);
  }

  if (!secretJsonEnc) {
    return {};
  }

  options.logger?.warn?.('using plaintext source secrets because no secretCodec was configured', {
    ownerId,
  });

  return parseSecretJson(secretJsonEnc);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface MemoryRateLimiter {
  allow(key: string, now: number): boolean;
}

function createMemoryRateLimiter(config: RateLimitConfig): MemoryRateLimiter {
  const buckets = new Map<string, { windowStart: number; count: number }>();

  return {
    allow(key, now) {
      const current = buckets.get(key);

      if (!current || now - current.windowStart >= config.windowMs) {
        buckets.set(key, {
          windowStart: now,
          count: 1,
        });
        pruneRateLimitBuckets(buckets, now, config.windowMs);
        return true;
      }

      if (current.count >= config.max) {
        return false;
      }

      current.count += 1;
      return true;
    },
  };
}

function pruneRateLimitBuckets(
  buckets: Map<string, { windowStart: number; count: number }>,
  now: number,
  windowMs: number,
): void {
  if (buckets.size < 1_000) {
    return;
  }

  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.windowStart >= windowMs) {
      buckets.delete(key);
    }
  }
}

function clientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function defaultDatabasePath(): string {
  const fromEnv = process.env.KANAME_SQLITE_PATH ?? process.env.DATABASE_URL;

  if (fromEnv) {
    return resolve(fromEnv.startsWith('file:') ? fromEnv.slice('file:'.length) : fromEnv);
  }

  return resolve('data', 'kaname-relay.sqlite');
}

function runtimeMigrationsDir(): string {
  return resolve(process.env.KANAME_MIGRATIONS_DIR ?? resolve('packages', 'store', 'migrations'));
}

function defaultWebDir(): string | null {
  const fromEnv = process.env.KANAME_WEB_DIR;

  if (fromEnv === 'disabled') {
    return null;
  }

  return resolve(fromEnv ?? resolve('apps', 'web', 'dist'));
}

function secretCodecFromRuntime(databasePath: string): SecretCodec {
  const configuredSecret = nonEmptyString(process.env.APP_SECRET ?? process.env.KANAME_APP_SECRET);
  const configuredSecretFile = nonEmptyString(process.env.KANAME_APP_SECRET_FILE);
  const secretFile = configuredSecretFile
    ? resolve(configuredSecretFile)
    : resolve(dirname(databasePath), '.kaname-app-secret');

  if (configuredSecret) {
    persistSecretIfMissing(secretFile, configuredSecret);
    return createAesGcmSecretCodec(configuredSecret);
  }

  if (existsSync(secretFile)) {
    return createAesGcmSecretCodec(readRequiredSecret(secretFile));
  }

  const generatedSecret = randomBytes(32).toString('hex');
  persistSecretIfMissing(secretFile, generatedSecret);

  return createAesGcmSecretCodec(readRequiredSecret(secretFile));
}

function persistSecretIfMissing(secretFile: string, secret: string): void {
  mkdirSync(dirname(secretFile), { recursive: true });

  if (existsSync(secretFile)) {
    return;
  }

  try {
    writeFileSync(secretFile, `${secret}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }
}

function readRequiredSecret(secretFile: string): string {
  const secret = readFileSync(secretFile, 'utf8').trim();

  if (secret.length === 0) {
    throw new Error(`runtime app secret file is empty: ${secretFile}`);
  }

  return secret;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();

  return normalized ? normalized : undefined;
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runtime = createNodeRuntime({
    logger: console,
  });
  runtime.start();
}
