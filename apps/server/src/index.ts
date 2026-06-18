import { processPending } from '@kaname-relay/core';
import {
  matchesRule,
  parseGenericEvent,
  renderNotificationMessage,
  type JsonObject,
  type JsonValue,
  type Logger,
  type Notifier,
  type ProcessPendingArgs,
  type ProcessPendingResult,
} from '@kaname-relay/core';
import { createTelegramNotifier } from '@kaname-relay/notifiers';
import {
  applySqliteMigrations,
  SqliteProcessPendingStore,
  SqliteStore,
  type NewOutboxItem,
  type RuleRecord,
} from '@kaname-relay/store';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ServerAppOptions {
  store: SqliteStore;
  now?: () => number;
  idGenerator?: () => string;
  maxBodyBytes?: number;
  maxAttempts?: number;
  triggerProcessing?: () => void | Promise<void>;
  logger?: Logger;
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
}

export interface ProcessScheduler {
  tick(): Promise<ProcessPendingResult | null>;
  start(): void;
  stop(): void;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_ATTEMPTS = 10;

export function createServerApp(options: ServerAppOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  app.get('/healthz', (context) => context.json({ ok: true }));

  app.post('/hooks/:sourceId', async (context) => {
    const sourceId = context.req.param('sourceId');
    const source = await options.store.getEnabledSource(sourceId);

    if (!source) {
      return context.json({ error: 'source not found or disabled' }, 404);
    }

    if (source.type !== 'generic') {
      return context.json({ error: `unsupported source type: ${source.type}` }, 400);
    }

    const rawBody = await context.req.text();

    if (byteLength(rawBody) > maxBodyBytes) {
      return context.json({ error: 'payload too large' }, 413);
    }

    const payloadResult = parseJsonObject(rawBody);

    if (!payloadResult.ok) {
      return context.json({ error: payloadResult.error }, 400);
    }

    const sourceConfig = parseStoredJsonObject(source.configJson, `source config ${source.id}`);
    const parsedEvent = parseGenericEvent(payloadResult.value, sourceConfig);
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
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
      maxAttempts,
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

    const processArgs: ProcessPendingArgs = {
      store: options.store,
      notifiers: options.notifiers,
      now,
      idGenerator,
      limit: options.limit ?? 25,
      recoverLimit: options.recoverLimit ?? 50,
      leaseMs: options.leaseMs ?? 90_000,
      sendTimeoutMs: options.sendTimeoutMs ?? 15_000,
      maxConcurrency: options.maxConcurrency ?? 4,
      backoff: {
        initialDelayMs: 30_000,
        multiplier: 2,
        maxDelayMs: 1_800_000,
        jitterRatio: 0.2,
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
    logger?: Logger;
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
  applySqliteMigrations(db);

  const store = new SqliteStore(db);
  const processStore = new SqliteProcessPendingStore(
    store,
    options.logger === undefined ? {} : { logger: options.logger },
  );
  const schedulerOptions: ProcessSchedulerOptions = {
    store: processStore,
    notifiers: {
      telegram: createTelegramNotifier(),
    },
  };

  if (options.logger !== undefined) {
    schedulerOptions.logger = options.logger;
  }

  const scheduler = createProcessScheduler(schedulerOptions);
  const appOptions: ServerAppOptions = {
    store,
    triggerProcessing: async () => {
      await scheduler.tick();
    },
  };

  if (options.logger !== undefined) {
    appOptions.logger = options.logger;
  }

  const app = createServerApp(appOptions);
  let server: ReturnType<typeof serve> | undefined;

  return {
    app,
    db,
    store,
    scheduler,
    start() {
      scheduler.start();
      server = serve({
        fetch: app.fetch,
        port: options.port ?? numberFromEnv(process.env.PORT) ?? 3000,
      });
    },
    stop() {
      scheduler.stop();
      server?.close();
      db.close();
    },
  };
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

    for (const channel of channels) {
      const templateJson = channel.templateOverrideJson ?? rule.templateJson;
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

function defaultDatabasePath(): string {
  const fromEnv = process.env.KANAME_SQLITE_PATH ?? process.env.DATABASE_URL;

  if (fromEnv) {
    return resolve(fromEnv.startsWith('file:') ? fromEnv.slice('file:'.length) : fromEnv);
  }

  return resolve('data', 'kaname-relay.sqlite');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runtime = createNodeRuntime({
    logger: console,
  });
  runtime.start();
}
