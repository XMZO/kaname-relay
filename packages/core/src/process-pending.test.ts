import { afterEach, describe, expect, it, vi } from 'vitest';

import { processPending } from './process-pending.js';
import type {
  CancelOutboxInput,
  ChannelConfig,
  ClaimDueOutboxInput,
  InsertSentLogResult,
  MarkOutboxDeadInput,
  MarkOutboxSentInput,
  NewSentLogEntry,
  Notifier,
  OutboxItem,
  ProcessPendingArgs,
  ProcessPendingStore,
  RecoverExpiredLeasesInput,
  RecoverExpiredLeasesResult,
  ScheduleOutboxRetryInput,
  SentLogEntry,
} from './types.js';

class MemoryStore implements ProcessPendingStore {
  public readonly items = new Map<string, OutboxItem>();
  public readonly channels = new Map<string, ChannelConfig>();
  public readonly sentLogs = new Map<string, SentLogEntry>();
  public readonly events: string[] = [];
  public recoverInput: RecoverExpiredLeasesInput | null = null;
  public recovered: RecoverExpiredLeasesResult = { retried: 0, dead: 0 };
  public insertSentLogResultOverride: InsertSentLogResult | null = null;
  public markSentByLeaseResult: boolean | null = null;
  public readonly throwOnChannelIds = new Set<string>();

  public constructor(items: OutboxItem[] = []) {
    for (const item of items) {
      this.items.set(item.id, { ...item });
    }
  }

  public recoverExpiredLeases(
    input: RecoverExpiredLeasesInput,
  ): Promise<RecoverExpiredLeasesResult> {
    this.events.push('recoverExpiredLeases');
    this.recoverInput = input;

    return Promise.resolve(this.recovered);
  }

  public claimDueOutbox(input: ClaimDueOutboxInput): Promise<OutboxItem[]> {
    this.events.push('claimDueOutbox');
    const claimed = [...this.items.values()]
      .filter((item) => item.status === 'pending' && item.nextAt <= input.now)
      .sort((left, right) => right.priority - left.priority || left.nextAt - right.nextAt)
      .slice(0, input.limit);

    for (const item of claimed) {
      item.status = 'sending';
      item.leaseId = input.leaseId;
      item.lockedUntil = input.leaseUntil;
    }

    return Promise.resolve(claimed.map((item) => ({ ...item })));
  }

  public getEnabledChannel(id: string): Promise<ChannelConfig | null> {
    this.events.push(`getEnabledChannel:${id}`);

    if (this.throwOnChannelIds.has(id)) {
      throw new Error(`channel lookup failed: ${id}`);
    }

    const channel = this.channels.get(id);

    return Promise.resolve(channel?.enabled ? channel : null);
  }

  public findSentLogByDedupeKey(outboundDedupeKey: string): Promise<SentLogEntry | null> {
    this.events.push(`findSentLogByDedupeKey:${outboundDedupeKey}`);

    return Promise.resolve(this.sentLogs.get(outboundDedupeKey) ?? null);
  }

  public insertSentLog(input: NewSentLogEntry): Promise<InsertSentLogResult> {
    this.events.push('insertSentLog');

    if (this.insertSentLogResultOverride) {
      return Promise.resolve(this.insertSentLogResultOverride);
    }

    const id = `sent-log-${this.sentLogs.size + 1}`;
    const entry: SentLogEntry = {
      id,
      outboxId: input.outboxId,
      channelId: input.channelId,
      notifierType: input.notifierType,
      sentAt: input.sentAt,
    };

    const result: InsertSentLogResult = {
      inserted: true,
      sentLogId: id,
    };

    if (input.outboundDedupeKey !== undefined) {
      entry.outboundDedupeKey = input.outboundDedupeKey;
    }

    if (input.providerMessageId !== undefined) {
      entry.providerMessageId = input.providerMessageId;
      result.providerMessageId = input.providerMessageId;
    }

    if (input.providerResponseJson !== undefined) {
      entry.providerResponseJson = input.providerResponseJson;
      result.providerResponseJson = input.providerResponseJson;
    }

    if (input.outboundDedupeKey) {
      this.sentLogs.set(input.outboundDedupeKey, entry);
    }

    return Promise.resolve(result);
  }

  public markOutboxSentByLease(input: MarkOutboxSentInput): Promise<boolean> {
    this.events.push('markOutboxSentByLease');

    if (this.markSentByLeaseResult !== null) {
      return Promise.resolve(this.markSentByLeaseResult);
    }

    const item = this.items.get(input.id);

    if (!item || item.status !== 'sending' || item.leaseId !== input.leaseId) {
      return Promise.resolve(false);
    }

    item.status = 'sent';
    item.leaseId = null;
    item.lockedUntil = null;

    return Promise.resolve(true);
  }

  public scheduleOutboxRetryByLease(input: ScheduleOutboxRetryInput): Promise<boolean> {
    this.events.push('scheduleOutboxRetryByLease');
    const item = this.items.get(input.id);

    if (!item || item.status !== 'sending' || item.leaseId !== input.leaseId) {
      return Promise.resolve(false);
    }

    item.status = 'pending';
    item.leaseId = null;
    item.lockedUntil = null;
    item.attempts = input.attempts;
    item.nextAt = input.nextAt;

    return Promise.resolve(true);
  }

  public markOutboxDeadByLease(input: MarkOutboxDeadInput): Promise<boolean> {
    this.events.push('markOutboxDeadByLease');
    const item = this.items.get(input.id);

    if (!item || item.status !== 'sending' || item.leaseId !== input.leaseId) {
      return Promise.resolve(false);
    }

    item.status = 'dead';
    item.leaseId = null;
    item.lockedUntil = null;
    item.attempts = input.attempts;

    return Promise.resolve(true);
  }

  public cancelOutboxByLease(input: CancelOutboxInput): Promise<boolean> {
    this.events.push('cancelOutboxByLease');
    const item = this.items.get(input.id);

    if (!item || item.status !== 'sending' || item.leaseId !== input.leaseId) {
      return Promise.resolve(false);
    }

    item.status = 'cancelled';
    item.leaseId = null;
    item.lockedUntil = null;

    return Promise.resolve(true);
  }
}

const telegramChannel: ChannelConfig = {
  id: 'channel-1',
  name: 'Telegram',
  type: 'telegram',
  enabled: true,
  config: {},
  secrets: {},
};

afterEach(() => {
  vi.useRealTimers();
});

function outboxItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'outbox-1',
    sourceId: 'source-1',
    channelId: 'channel-1',
    notifierType: 'telegram',
    status: 'pending',
    priority: 0,
    nextAt: 1_000,
    attempts: 0,
    maxAttempts: 3,
    outboundDedupeKey: 'dedupe-1',
    message: {
      text: 'hello',
    },
    ...overrides,
  };
}

function argsFor(
  store: MemoryStore,
  overrides: Partial<ProcessPendingArgs> = {},
): ProcessPendingArgs {
  return {
    store,
    notifiers: {},
    now: () => 1_000,
    idGenerator: () => 'lease-1',
    limit: 10,
    recoverLimit: 20,
    leaseMs: 90_000,
    sendTimeoutMs: 10_000,
    maxConcurrency: 2,
    backoff: {
      initialDelayMs: 30_000,
      multiplier: 2,
      maxDelayMs: 1_800_000,
    },
    random: () => 0.5,
    ...overrides,
  };
}

describe('processPending', () => {
  it('recovers leases, sends notifications, writes sent_log, and marks outbox sent', async () => {
    const store = new MemoryStore([outboxItem()]);
    store.channels.set('channel-1', telegramChannel);
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'tg-1',
      providerResponseJson: { ok: true },
    });

    const result = await processPending(
      argsFor(store, {
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    expect(result).toEqual({
      recovered: { retried: 0, dead: 0 },
      claimed: 1,
      sent: 1,
      deduped: 0,
      retried: 0,
      dead: 0,
      cancelled: 0,
      leaseLost: 0,
      errored: 0,
    });
    expect(store.recoverInput).toMatchObject({
      now: 1_000,
      limit: 20,
      maxBackoffDelayMs: 1_800_000,
    });
    expect(store.recoverInput?.backoffDelaysMsByAttempt[1]).toBe(30_000);
    expect(send).toHaveBeenCalledWith(
      { text: 'hello' },
      expect.objectContaining({
        channel: telegramChannel,
        idempotencyKey: 'dedupe-1',
      }),
    );
    expect(store.items.get('outbox-1')?.status).toBe('sent');
    expect(store.sentLogs.get('dedupe-1')).toMatchObject({
      providerMessageId: 'tg-1',
      providerResponseJson: { ok: true },
    });
    expect(store.events).toContain('insertSentLog');
    expect(store.events.indexOf('insertSentLog')).toBeLessThan(
      store.events.indexOf('markOutboxSentByLease'),
    );
  });

  it('uses sent_log dedupe without calling the notifier', async () => {
    const store = new MemoryStore([outboxItem()]);
    store.channels.set('channel-1', telegramChannel);
    store.sentLogs.set('dedupe-1', {
      id: 'sent-log-existing',
      outboxId: 'other-outbox',
      outboundDedupeKey: 'dedupe-1',
      channelId: 'channel-1',
      notifierType: 'telegram',
      providerMessageId: 'existing-provider-id',
      providerResponseJson: { ok: true, deduped: true },
      sentAt: 500,
    });
    const send = vi.fn<Notifier['send']>().mockResolvedValue({});

    const result = await processPending(
      argsFor(store, {
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    expect(result.deduped).toBe(1);
    expect(result.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(store.items.get('outbox-1')?.status).toBe('sent');
  });

  it('honors insertSentLog inserted=false conflict results without another notifier call', async () => {
    const store = new MemoryStore([outboxItem()]);
    store.channels.set('channel-1', telegramChannel);
    store.insertSentLogResultOverride = {
      inserted: false,
      sentLogId: 'sent-log-existing',
      providerMessageId: 'existing-provider-id',
      providerResponseJson: { ok: true, existing: true },
    };
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'new-provider-id',
      providerResponseJson: { ok: true, existing: false },
    });

    const result = await processPending(
      argsFor(store, {
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    expect(result.sent).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.dead).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.items.get('outbox-1')?.status).toBe('sent');
  });

  it('schedules retryable notifier failures with exponential backoff', async () => {
    const store = new MemoryStore([outboxItem()]);
    store.channels.set('channel-1', telegramChannel);
    const error = Object.assign(new Error('rate limited'), {
      retryable: true,
      statusCode: 429,
    });
    const send = vi.fn<Notifier['send']>().mockRejectedValue(error);

    const result = await processPending(
      argsFor(store, {
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    expect(result.retried).toBe(1);
    expect(result.dead).toBe(0);
    expect(store.items.get('outbox-1')).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAt: 31_000,
      leaseId: null,
      lockedUntil: null,
    });
  });

  it('counts leaseLost when a lease guarded mutation returns false', async () => {
    const store = new MemoryStore([outboxItem()]);
    store.channels.set('channel-1', telegramChannel);
    store.markSentByLeaseResult = false;
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'tg-lost',
    });

    const result = await processPending(
      argsFor(store, {
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    expect(result).toMatchObject({
      sent: 0,
      leaseLost: 1,
      errored: 0,
    });
    expect(store.items.get('outbox-1')?.status).toBe('sending');
  });

  it('schedules retry when notifier send exceeds sendTimeoutMs', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore([outboxItem()]);
    store.channels.set('channel-1', telegramChannel);
    const send = vi.fn<Notifier['send']>().mockImplementation(
      () =>
        new Promise(() => {
          // Intentionally never resolves; timeout owns the outcome.
        }),
    );

    const pending = processPending(
      argsFor(store, {
        sendTimeoutMs: 5,
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(5);

    const result = await pending;

    expect(result.retried).toBe(1);
    expect(result.errored).toBe(0);
    expect(store.items.get('outbox-1')).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAt: 31_000,
    });
  });

  it('marks non-retryable notifier failures dead', async () => {
    const store = new MemoryStore([outboxItem()]);
    store.channels.set('channel-1', telegramChannel);
    const error = Object.assign(new Error('invalid token'), {
      retryable: false,
      statusCode: 401,
    });
    const send = vi.fn<Notifier['send']>().mockRejectedValue(error);

    const result = await processPending(
      argsFor(store, {
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    expect(result.dead).toBe(1);
    expect(store.items.get('outbox-1')).toMatchObject({
      status: 'dead',
      attempts: 1,
      leaseId: null,
      lockedUntil: null,
    });
  });

  it('cancels tasks when the channel is disabled or missing', async () => {
    const store = new MemoryStore([outboxItem()]);

    const result = await processPending(argsFor(store));

    expect(result.cancelled).toBe(1);
    expect(store.items.get('outbox-1')?.status).toBe('cancelled');
  });

  it('isolates unexpected store errors to the item and lets siblings finish', async () => {
    const store = new MemoryStore([
      outboxItem({
        id: 'outbox-error',
        channelId: 'channel-error',
        outboundDedupeKey: 'dedupe-error',
      }),
      outboxItem({
        id: 'outbox-ok',
        channelId: 'channel-1',
        outboundDedupeKey: 'dedupe-ok',
      }),
    ]);
    store.channels.set('channel-1', telegramChannel);
    store.throwOnChannelIds.add('channel-error');
    const logger = {
      error: vi.fn(),
    };
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'tg-ok',
    });

    const result = await processPending(
      argsFor(store, {
        logger,
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
      }),
    );

    expect(result).toMatchObject({
      claimed: 2,
      sent: 1,
      errored: 1,
      leaseLost: 0,
    });
    expect(store.items.get('outbox-error')?.status).toBe('sending');
    expect(store.items.get('outbox-ok')?.status).toBe('sent');
    expect(logger.error).toHaveBeenCalledWith(
      'unexpected processPending item error',
      expect.objectContaining({
        outboxId: 'outbox-error',
      }),
    );
  });
});
