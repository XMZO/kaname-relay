import { Hono, type Context } from 'hono';

import {
  matchesRule,
  parseGenericEvent,
  processPending,
  renderNotificationMessage,
  type JsonObject,
  type JsonValue,
  type Logger,
  type Notifier,
  type ProcessPendingArgs,
  type ProcessPendingResult,
} from '@kaname-relay/core';
import { createTelegramNotifier } from '@kaname-relay/notifiers';
import { D1Store, type D1DatabaseLike } from '@kaname-relay/store/d1';
import { D1ProcessPendingStore } from '@kaname-relay/store/process';
import type { NewOutboxItem, RuleRecord } from '@kaname-relay/store/types';

interface AssetFetcher {
  fetch(request: Request): Promise<Response> | Response;
}

export interface WorkerBindings {
  DB: D1DatabaseLike;
  ASSETS?: AssetFetcher;
}

interface WorkerHonoEnv {
  Bindings: WorkerBindings;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledControllerLike {
  scheduledTime?: number;
  cron?: string;
}

export interface WorkerProcessOptions {
  now?: () => number;
  idGenerator?: () => string;
  notifiers?: Record<string, Notifier | undefined>;
  logger?: Logger;
  limit?: number;
  recoverLimit?: number;
  leaseMs?: number;
  sendTimeoutMs?: number;
  maxConcurrency?: number;
  random?: () => number;
}

export interface WorkerAppOptions extends WorkerProcessOptions {
  maxBodyBytes?: number;
  maxAttempts?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_ATTEMPTS = 10;

export function createWorkerApp(options: WorkerAppOptions = {}): Hono<WorkerHonoEnv> {
  const app = new Hono<WorkerHonoEnv>();
  const now = options.now ?? Date.now;
  const idGenerator = options.idGenerator ?? randomId;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  app.onError((error, context) => {
    options.logger?.error?.('worker request failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });

    return context.json({ error: 'internal server error' }, 500);
  });

  app.get('/healthz', (context) => context.json({ ok: true }));

  app.post('/hooks/:sourceId', async (context) => {
    const contentLength = numberFromHeader(context.req.header('content-length'));

    if (contentLength !== undefined && contentLength > maxBodyBytes) {
      return context.json({ error: 'payload too large' }, 413);
    }

    const store = new D1Store(context.env.DB);
    const sourceId = context.req.param('sourceId');
    const source = await store.getEnabledSource(sourceId);

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

    const receivedAt = now();
    const sourceConfig = parseStoredJsonObject(source.configJson, `source config ${source.id}`);
    const parsedEvent = parseGenericEvent(payloadResult.value, sourceConfig);
    const payloadHash = await sha256Hex(rawBody);
    const receivedEventId = idGenerator();
    const rules = await store.listEnabledRulesForSource(source.id);
    const outboxItems = await buildOutboxItems({
      store,
      rules,
      sourceId: source.id,
      payload: parsedEvent.payload,
      payloadJson: rawBody,
      inboundDedupeKey: parsedEvent.inboundDedupeKey,
      eventType: parsedEvent.eventType,
      now: receivedAt,
      maxAttempts,
      idGenerator,
    });

    const ingestResult = await store.ingest({
      now: receivedAt,
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
      waitUntil(
        context,
        runWorkerProcess(context.env, {
          ...processOptions(options),
          limit: options.limit ?? 10,
          recoverLimit: options.recoverLimit ?? 20,
        }),
        options.logger,
      );
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

  app.notFound((context) => {
    if (context.req.method === 'GET' || context.req.method === 'HEAD') {
      return (
        context.env.ASSETS?.fetch(context.req.raw) ?? context.json({ error: 'not found' }, 404)
      );
    }

    return context.json({ error: 'not found' }, 404);
  });

  return app;
}

export function runWorkerProcess(
  env: WorkerBindings,
  options: WorkerProcessOptions = {},
): Promise<ProcessPendingResult> {
  const store = new D1Store(env.DB);
  const processStore = new D1ProcessPendingStore(
    store,
    options.logger === undefined ? {} : { logger: options.logger },
  );
  const args: ProcessPendingArgs = {
    store: processStore,
    notifiers: options.notifiers ?? {
      telegram: createTelegramNotifier(),
    },
    now: options.now ?? Date.now,
    idGenerator: options.idGenerator ?? randomId,
    limit: options.limit ?? 10,
    recoverLimit: options.recoverLimit ?? 20,
    leaseMs: options.leaseMs ?? 90_000,
    sendTimeoutMs: options.sendTimeoutMs ?? 15_000,
    maxConcurrency: options.maxConcurrency ?? 2,
    backoff: {
      initialDelayMs: 30_000,
      multiplier: 2,
      maxDelayMs: 1_800_000,
      jitterRatio: 0.2,
    },
  };

  if (options.random !== undefined) {
    args.random = options.random;
  }

  if (options.logger !== undefined) {
    args.logger = options.logger;
  }

  return processPending(args);
}

interface BuildOutboxInput {
  store: D1Store;
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

function processOptions(options: WorkerProcessOptions): WorkerProcessOptions {
  const selected: WorkerProcessOptions = {};

  if (options.now !== undefined) {
    selected.now = options.now;
  }

  if (options.idGenerator !== undefined) {
    selected.idGenerator = options.idGenerator;
  }

  if (options.notifiers !== undefined) {
    selected.notifiers = options.notifiers;
  }

  if (options.logger !== undefined) {
    selected.logger = options.logger;
  }

  if (options.leaseMs !== undefined) {
    selected.leaseMs = options.leaseMs;
  }

  if (options.sendTimeoutMs !== undefined) {
    selected.sendTimeoutMs = options.sendTimeoutMs;
  }

  if (options.maxConcurrency !== undefined) {
    selected.maxConcurrency = options.maxConcurrency;
  }

  if (options.random !== undefined) {
    selected.random = options.random;
  }

  return selected;
}

function waitUntil(
  context: Context<WorkerHonoEnv>,
  promise: Promise<unknown>,
  logger: Logger | undefined,
): void {
  const guarded = promise.catch((error: unknown) => {
    logger?.error?.('worker background processing failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
  });

  try {
    context.executionCtx.waitUntil(guarded);
  } catch {
    void guarded;
  }
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

function numberFromHeader(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomId(): string {
  return crypto.randomUUID();
}

const app = createWorkerApp();

export default {
  fetch: app.fetch,
  scheduled(
    controller: ScheduledControllerLike,
    env: WorkerBindings,
    context: WorkerExecutionContext,
  ): void {
    void controller;
    context.waitUntil(
      runWorkerProcess(env, {
        limit: 25,
        recoverLimit: 50,
      }),
    );
  },
};
