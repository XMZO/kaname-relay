import { buildBackoffDelayMap, computeBackoffMs } from './backoff.js';
import { classifyNotifierError } from './errors.js';
import type {
  JsonObject,
  MarkOutboxSentInput,
  NewSentLogEntry,
  Notifier,
  NotifierResult,
  OutboxItem,
  ProcessPendingArgs,
  ProcessPendingResult,
} from './types.js';

export async function processPending(args: ProcessPendingArgs): Promise<ProcessPendingResult> {
  const startedAt = args.now();
  const leaseId = args.idGenerator();
  const leaseUntil = startedAt + args.leaseMs;
  const random = args.random ?? Math.random;

  const recovered = await args.store.recoverExpiredLeases({
    now: startedAt,
    limit: args.recoverLimit,
    backoffDelaysMsByAttempt: buildBackoffDelayMap(args.backoff, random),
    maxBackoffDelayMs: args.backoff.maxDelayMs,
  });

  const items = await args.store.claimDueOutbox({
    now: startedAt,
    leaseId,
    leaseUntil,
    limit: args.limit,
  });

  const result: ProcessPendingResult = {
    recovered,
    claimed: items.length,
    sent: 0,
    deduped: 0,
    retried: 0,
    dead: 0,
    cancelled: 0,
    leaseLost: 0,
    errored: 0,
  };

  await runWithConcurrency(items, Math.max(1, args.maxConcurrency), async (item) => {
    await processOne({
      args,
      item,
      leaseId,
      result,
      random,
    });
  });

  return result;
}

interface ProcessOneInput {
  args: ProcessPendingArgs;
  item: OutboxItem;
  leaseId: string;
  result: ProcessPendingResult;
  random: () => number;
}

async function processOne(input: ProcessOneInput): Promise<void> {
  const { args, item, leaseId, result, random } = input;

  try {
    await processOneIsolated({
      args,
      item,
      leaseId,
      result,
      random,
    });
  } catch (error) {
    result.errored += 1;
    args.logger?.error?.('unexpected processPending item error', {
      outboxId: item.id,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

async function processOneIsolated(input: ProcessOneInput): Promise<void> {
  const { args, item, leaseId, result, random } = input;

  if (item.outboundDedupeKey) {
    const existing = await args.store.findSentLogByDedupeKey(item.outboundDedupeKey);

    if (existing) {
      const markInput = markSentInput({
        item,
        leaseId,
        now: args.now(),
      });

      if (existing.providerMessageId !== undefined) {
        markInput.providerMessageId = existing.providerMessageId;
      }

      if (existing.providerResponseJson !== undefined) {
        markInput.providerResponseJson = existing.providerResponseJson;
      }

      const marked = await args.store.markOutboxSentByLease(markInput);

      increment(result, marked ? 'deduped' : 'leaseLost');
      return;
    }
  }

  const channel = await args.store.getEnabledChannel(item.channelId);

  if (!channel) {
    const cancelled = await args.store.cancelOutboxByLease({
      id: item.id,
      leaseId,
      now: args.now(),
      reason: 'channel disabled or deleted',
    });

    increment(result, cancelled ? 'cancelled' : 'leaseLost');
    return;
  }

  const notifier = args.notifiers[channel.type];

  if (!notifier) {
    const marked = await args.store.markOutboxDeadByLease({
      id: item.id,
      leaseId,
      now: args.now(),
      attempts: item.attempts + 1,
      error: `notifier not registered: ${channel.type}`,
    });

    increment(result, marked ? 'dead' : 'leaseLost');
    return;
  }

  const context = {
    channel,
    idempotencyKey: item.providerIdempotencyKey ?? item.outboundDedupeKey ?? item.id,
    now: args.now,
  };

  let sendResult: NotifierResult;

  try {
    sendResult = await sendWithTimeout(
      notifier,
      item,
      args.logger ? { ...context, logger: args.logger } : context,
      args.sendTimeoutMs,
    );
  } catch (error) {
    await handleSendFailure({
      args,
      item,
      leaseId,
      result,
      random,
      error,
    });
    return;
  }

  const sentLog = await args.store.insertSentLog(
    sentLogInput({
      item,
      sendResult,
      sentAt: args.now(),
    }),
  );

  const markInput = markSentInput({
    item,
    leaseId,
    now: args.now(),
  });
  const providerMessageId = sentLog.providerMessageId ?? sendResult.providerMessageId;
  const providerResponseJson = sentLog.providerResponseJson ?? sendResult.providerResponseJson;

  if (providerMessageId !== undefined) {
    markInput.providerMessageId = providerMessageId;
  }

  if (providerResponseJson !== undefined) {
    markInput.providerResponseJson = providerResponseJson;
  }

  const marked = await args.store.markOutboxSentByLease(markInput);

  increment(result, marked ? 'sent' : 'leaseLost');
}

async function handleSendFailure(input: ProcessOneInput & { error: unknown }): Promise<void> {
  const { args, item, leaseId, result, random, error } = input;
  const failure = classifyNotifierError(error);
  const attempts = item.attempts + 1;

  if (!failure.retryable || attempts >= item.maxAttempts) {
    const marked = await args.store.markOutboxDeadByLease({
      id: item.id,
      leaseId,
      now: args.now(),
      attempts,
      error: failure.message,
    });

    increment(result, marked ? 'dead' : 'leaseLost');
    return;
  }

  const marked = await args.store.scheduleOutboxRetryByLease({
    id: item.id,
    leaseId,
    now: args.now(),
    attempts,
    nextAt: args.now() + computeBackoffMs(attempts, args.backoff, random),
    error: failure.message,
  });

  increment(result, marked ? 'retried' : 'leaseLost');
}

async function sendWithTimeout(
  notifier: Notifier,
  item: OutboxItem,
  context: Omit<Parameters<Notifier['send']>[1], 'signal'>,
  timeoutMs: number,
): Promise<NotifierResult> {
  const controller = new AbortController();
  const timeoutError = new Error(`notifier timed out after ${timeoutMs}ms`);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const sendPromise = notifier.send(item.message, {
      ...context,
      signal: controller.signal,
    });
    sendPromise.catch(() => {});
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    return await Promise.race([sendPromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function sentLogInput(input: {
  item: OutboxItem;
  sendResult: NotifierResult;
  sentAt: number;
}): NewSentLogEntry {
  const sentLog: NewSentLogEntry = {
    outboxId: input.item.id,
    channelId: input.item.channelId,
    notifierType: input.item.notifierType,
    sentAt: input.sentAt,
  };

  if (input.item.outboundDedupeKey !== undefined) {
    sentLog.outboundDedupeKey = input.item.outboundDedupeKey;
  }

  if (input.sendResult.providerMessageId !== undefined) {
    sentLog.providerMessageId = input.sendResult.providerMessageId;
  }

  if (input.sendResult.providerResponseJson !== undefined) {
    sentLog.providerResponseJson = input.sendResult.providerResponseJson;
  }

  return sentLog;
}

function markSentInput(input: {
  item: OutboxItem;
  leaseId: string;
  now: number;
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
}): MarkOutboxSentInput {
  const markSent: MarkOutboxSentInput = {
    id: input.item.id,
    leaseId: input.leaseId,
    now: input.now,
  };

  if (input.providerMessageId !== undefined) {
    markSent.providerMessageId = input.providerMessageId;
  }

  if (input.providerResponseJson !== undefined) {
    markSent.providerResponseJson = input.providerResponseJson;
  }

  return markSent;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;

      if (item !== undefined) {
        await worker(item);
      }
    }
  });

  await Promise.all(workers);
}

function increment(
  result: ProcessPendingResult,
  key: 'sent' | 'deduped' | 'retried' | 'dead' | 'cancelled' | 'leaseLost',
): void {
  result[key] += 1;
}
