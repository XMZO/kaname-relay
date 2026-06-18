import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Notifier } from '@kaname-relay/core';
import { applySqliteMigrations } from '@kaname-relay/store';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '@kaname-relay/store/d1';

import { createWorkerApp, runWorkerProcess, type WorkerBindings } from './index.js';

interface Harness {
  db: Database.Database;
  d1: FakeD1Database;
  dir: string;
}

const cleanupHandles: Array<{ db: Database.Database; dir: string }> = [];

afterEach(() => {
  while (cleanupHandles.length > 0) {
    const handle = cleanupHandles.pop();

    if (handle) {
      handle.db.close();
      rmSync(handle.dir, { force: true, recursive: true });
    }
  }
});

class FakeD1Database implements D1DatabaseLike {
  public constructor(private readonly db: Database.Database) {}

  public prepare(query: string): D1PreparedStatementLike {
    return new FakeD1PreparedStatement(this.db, query, []);
  }

  public batch<T = unknown>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>> {
    const runBatch = this.db.transaction(() =>
      statements.map((statement) => (statement as FakeD1PreparedStatement).execute<T>()),
    );

    return Promise.resolve(runBatch());
  }
}

class FakeD1PreparedStatement implements D1PreparedStatementLike {
  public constructor(
    private readonly db: Database.Database,
    private readonly query: string,
    private readonly values: unknown[],
  ) {}

  public bind(...values: unknown[]): D1PreparedStatementLike {
    return new FakeD1PreparedStatement(this.db, this.query, values);
  }

  public first<T = unknown>(): Promise<T | null> {
    const row = this.db.prepare(this.query).get(...this.values) as T | undefined;

    return Promise.resolve(row ?? null);
  }

  public all<T = unknown>(): Promise<D1ResultLike<T>> {
    return Promise.resolve(this.execute<T>());
  }

  public run<T = unknown>(): Promise<D1ResultLike<T>> {
    return Promise.resolve(this.execute<T>());
  }

  public execute<T = unknown>(): D1ResultLike<T> {
    const hasReturning = /\bRETURNING\b/i.test(this.query);

    if (hasReturning || /^\s*SELECT\b/i.test(this.query)) {
      const rows = this.db.prepare(this.query).all(...this.values) as T[];

      return {
        results: rows,
        meta: {
          changes: hasReturning ? rows.length : 0,
        },
      };
    }

    const result = this.db.prepare(this.query).run(...this.values);

    return {
      results: [],
      meta: {
        changes: result.changes,
      },
    };
  }
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-worker-'));
  const db = new Database(join(dir, 'test.sqlite'));
  cleanupHandles.push({ db, dir });
  applySqliteMigrations(db);
  seedWebhookChain(db);

  return {
    db,
    d1: new FakeD1Database(db),
    dir,
  };
}

function seedWebhookChain(db: Database.Database, now = 1_000): void {
  db.prepare(
    `
    INSERT INTO webhook_sources (
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (
      'source-1',
      'Source 1',
      'generic',
      1,
      '{"inboundDedupePath":"$.id","eventTypePath":"$.eventType"}',
      :now,
      :now
    )
    `,
  ).run({ now });

  db.prepare(
    `
    INSERT INTO channels (
      id, name, type, enabled, config_json, secret_json_enc, created_at, updated_at
    ) VALUES (
      'channel-1',
      'Telegram',
      'telegram',
      1,
      '{"chatId":"12345"}',
      '{"botToken":"token"}',
      :now,
      :now
    )
    `,
  ).run({ now });

  db.prepare(
    `
    INSERT INTO rules (
      id, source_id, name, enabled, priority, match_json, template_json,
      stop_on_match, created_at, updated_at
    ) VALUES (
      'rule-1',
      'source-1',
      'Demo Rule',
      1,
      10,
      '{"op":"eq","path":"$.eventType","value":"demo"}',
      '{"text":"Hello {{payload.name}} from {{eventType}}","title":"{{sourceId}}"}',
      0,
      :now,
      :now
    )
    `,
  ).run({ now });

  db.prepare(
    `
    INSERT INTO rule_channels (
      rule_id, channel_id, enabled, created_at, updated_at
    ) VALUES (
      'rule-1', 'channel-1', 1, :now, :now
    )
    `,
  ).run({ now });
}

function workerEnv(d1: FakeD1Database): WorkerBindings {
  return {
    DB: d1,
  };
}

describe('worker webhook endpoint', () => {
  it('accepts a webhook and processes it through D1 processPending in waitUntil', async () => {
    const { db, d1 } = createHarness();
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'provider-worker',
      providerResponseJson: {
        ok: true,
      },
    });
    const waits: Array<Promise<void>> = [];
    const executionContext = {
      passThroughOnException() {},
      waitUntil(promise: Promise<void>) {
        waits.push(promise);
      },
    };
    let id = 0;
    const app = createWorkerApp({
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
      notifiers: {
        telegram: {
          type: 'telegram',
          send,
        },
      },
      random: () => 0.5,
    });

    const response = await app.request(
      '/hooks/source-1',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: 'evt-worker',
          eventType: 'demo',
          name: 'Ada',
        }),
      },
      workerEnv(d1),
      executionContext as unknown as Parameters<typeof app.request>[3],
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      receivedEventId: 'id-1',
      outboxCount: 1,
    });
    expect(waits).toHaveLength(1);

    if (!waits[0]) {
      throw new Error('expected waitUntil to receive processPending promise');
    }

    await waits[0];

    expect(send).toHaveBeenCalledWith(
      {
        text: 'Hello Ada from demo',
        title: 'source-1',
      },
      expect.objectContaining({
        idempotencyKey: 'source-1:evt-worker:rule-1:channel-1',
        channel: expect.objectContaining({
          id: 'channel-1',
          config: {
            chatId: '12345',
          },
          secrets: {
            botToken: 'token',
          },
        }),
      }),
    );

    const sentLog = db
      .prepare(
        `
        SELECT outbox_id, outbound_dedupe_key, provider_message_id, provider_response_json
        FROM sent_log
        `,
      )
      .get() as {
      outbox_id: string;
      outbound_dedupe_key: string;
      provider_message_id: string;
      provider_response_json: string;
    };
    expect(sentLog).toEqual({
      outbox_id: 'id-2',
      outbound_dedupe_key: 'source-1:evt-worker:rule-1:channel-1',
      provider_message_id: 'provider-worker',
      provider_response_json: '{"ok":true}',
    });

    const outbox = db.prepare('SELECT status, sent_at FROM outbox WHERE id = ?').get('id-2') as {
      status: string;
      sent_at: number;
    };
    expect(outbox).toEqual({
      status: 'sent',
      sent_at: 10_000,
    });
  });
});

describe('runWorkerProcess', () => {
  it('processes pending D1 outbox rows without a request context', async () => {
    const { db, d1 } = createHarness();
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'provider-cron',
    });

    db.prepare(
      `
      INSERT INTO outbox (
        id, source_id, rule_id, channel_id, notifier_type, status,
        priority, next_at, attempts, max_attempts, outbound_dedupe_key,
        payload_json, message_json, created_at, updated_at
      ) VALUES (
        'outbox-cron', 'source-1', 'rule-1', 'channel-1', 'telegram', 'pending',
        0, 1_000, 0, 10, 'dedupe-cron',
        '{"ok":true}', '{"text":"cron hello","title":"Cron"}', 1_000, 1_000
      )
      `,
    ).run();

    await expect(
      runWorkerProcess(workerEnv(d1), {
        now: () => 10_000,
        idGenerator: () => 'lease-cron',
        notifiers: {
          telegram: {
            type: 'telegram',
            send,
          },
        },
        random: () => 0.5,
      }),
    ).resolves.toMatchObject({
      claimed: 1,
      sent: 1,
      retried: 0,
      dead: 0,
      leaseLost: 0,
      errored: 0,
    });

    expect(send).toHaveBeenCalledWith(
      {
        text: 'cron hello',
        title: 'Cron',
      },
      expect.objectContaining({
        idempotencyKey: 'dedupe-cron',
      }),
    );
  });
});
