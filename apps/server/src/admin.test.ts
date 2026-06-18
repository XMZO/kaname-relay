import type { Notifier } from '@kaname-relay/core';
import { applySqliteMigrations, SqliteStore } from '@kaname-relay/store';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from './index.js';

interface Harness {
  db: Database.Database;
  store: SqliteStore;
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

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-admin-'));
  const db = new Database(join(dir, 'test.sqlite'));
  cleanupHandles.push({ db, dir });
  applySqliteMigrations(db);

  return {
    db,
    store: new SqliteStore(db),
    dir,
  };
}

async function initialize(app: ReturnType<typeof createServerApp>): Promise<string> {
  const response = await app.request('/api/auth/init', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      password: 'correct horse battery staple',
    }),
  });

  expect(response.status).toBe(201);

  const cookie = response.headers.get('set-cookie')?.split(';')[0];

  if (!cookie) {
    throw new Error('expected session cookie');
  }

  return cookie;
}

describe('admin API', () => {
  it('initializes auth and manages sources, channels, rules, preview, and test sends', async () => {
    const { store } = createHarness();
    let id = 0;
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'test-provider',
      providerResponseJson: {
        ok: true,
      },
    });
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
      notifiers: {
        telegram: {
          type: 'telegram',
          send,
        },
      },
    });

    const denied = await app.request('/api/admin/dashboard');
    expect(denied.status).toBe(401);

    const cookie = await initialize(app);

    const sourceResponse = await app.request('/api/admin/sources', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        id: 'source-ui',
        name: 'UI Source',
        type: 'generic',
        config: {
          inboundDedupePath: '$.id',
          eventTypePath: '$.eventType',
        },
        secrets: {
          webhookSecret: 'never-echo-source',
        },
      }),
    });
    expect(sourceResponse.status).toBe(201);
    const sourceBody = (await sourceResponse.json()) as {
      source: { hasSecret: boolean; webhookPath: string; secrets?: unknown };
    };
    expect(sourceBody.source).toMatchObject({
      hasSecret: true,
      webhookPath: '/hooks/source-ui',
    });
    expect(JSON.stringify(sourceBody)).not.toContain('never-echo-source');

    const channelResponse = await app.request('/api/admin/channels', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        id: 'channel-ui',
        name: 'UI Telegram',
        type: 'telegram',
        config: {
          chatId: '12345',
        },
        secrets: {
          botToken: 'never-echo-token',
        },
      }),
    });
    expect(channelResponse.status).toBe(201);
    const channelBody = (await channelResponse.json()) as {
      channel: { hasSecret: boolean; secrets?: unknown };
    };
    expect(channelBody.channel.hasSecret).toBe(true);
    expect(JSON.stringify(channelBody)).not.toContain('never-echo-token');

    const ruleResponse = await app.request('/api/admin/rules', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        id: 'rule-ui',
        sourceId: 'source-ui',
        name: 'UI Rule',
        priority: 10,
        match: {
          op: 'starts_with',
          path: '$.eventType',
          value: 'demo',
        },
        template: {
          text: 'Hello {{payload.name}}',
          title: '{{eventType}}',
        },
        channelIds: ['channel-ui'],
      }),
    });
    expect(ruleResponse.status).toBe(201);

    const preview = await app.request('/api/admin/rules/rule-ui/preview', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        payload: {
          eventType: 'demo.created',
          name: 'Ada',
        },
      }),
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toEqual({
      matched: true,
      messages: [
        {
          channelId: 'channel-ui',
          message: {
            text: 'Hello Ada',
            title: 'demo.created',
          },
        },
      ],
    });

    const testSend = await app.request('/api/admin/channels/channel-ui/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        message: {
          text: 'Testing from UI',
          title: 'Manual Test',
        },
      }),
    });
    expect(testSend.status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      {
        text: 'Testing from UI',
        title: 'Manual Test',
      },
      expect.objectContaining({
        channel: expect.objectContaining({
          config: {
            chatId: '12345',
          },
          secrets: {
            botToken: 'never-echo-token',
          },
        }),
      }),
    );
  });

  it('lists outbox and sent-log rows, cancels pending work, and replays dead work', async () => {
    const { db, store } = createHarness();
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 20_000,
      idGenerator: () => `replay-${++id}`,
    });
    const cookie = await initialize(app);

    seedAdminOutbox(db);

    const dashboard = await app.request('/api/admin/dashboard', {
      headers: {
        cookie,
      },
    });
    expect(dashboard.status).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      outboxByStatus: {
        pending: 1,
        dead: 1,
      },
    });

    const outbox = await app.request('/api/admin/outbox?status=dead', {
      headers: {
        cookie,
      },
    });
    expect(outbox.status).toBe(200);
    await expect(outbox.json()).resolves.toMatchObject({
      outbox: [
        {
          id: 'dead-outbox',
          status: 'dead',
        },
      ],
    });

    const replay = await app.request('/api/admin/outbox/dead-outbox/replay', {
      method: 'POST',
      headers: {
        cookie,
      },
    });
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({
      item: {
        id: 'replay-1',
        status: 'pending',
        outboundDedupeKey: null,
      },
    });

    const cancel = await app.request('/api/admin/outbox/pending-outbox/cancel', {
      method: 'POST',
      headers: {
        cookie,
      },
    });
    expect(cancel.status).toBe(200);
    const cancelled = db
      .prepare('SELECT status, last_error FROM outbox WHERE id = ?')
      .get('pending-outbox') as { status: string; last_error: string };
    expect(cancelled).toEqual({
      status: 'cancelled',
      last_error: 'cancelled by admin',
    });

    const sentLog = await app.request('/api/admin/sent-log', {
      headers: {
        cookie,
      },
    });
    expect(sentLog.status).toBe(200);
    await expect(sentLog.json()).resolves.toMatchObject({
      sentLog: [
        {
          id: 'sent-log-1',
          outboxId: 'sent-outbox',
          providerMessageId: 'provider-1',
        },
      ],
    });
  });
});

function seedAdminOutbox(db: Database.Database): void {
  db.prepare(
    `
    INSERT INTO webhook_sources (
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (
      'source-admin', 'Admin Source', 'generic', 1, '{}', 1_000, 1_000
    )
    `,
  ).run();
  db.prepare(
    `
    INSERT INTO channels (
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (
      'channel-admin', 'Admin Channel', 'telegram', 1, '{}', 1_000, 1_000
    )
    `,
  ).run();

  const insertOutbox = db.prepare(
    `
    INSERT INTO outbox (
      id, source_id, channel_id, notifier_type, status, priority, next_at,
      attempts, max_attempts, payload_json, message_json, created_at, updated_at,
      dead_at, last_error, last_error_at
    ) VALUES (
      :id, 'source-admin', 'channel-admin', 'telegram', :status, 0, 1_000,
      0, 10, '{"ok":true}', '{"text":"hello"}', 1_000, 1_000,
      :dead_at, :last_error, :last_error_at
    )
    `,
  );
  insertOutbox.run({
    id: 'dead-outbox',
    status: 'dead',
    dead_at: 1_000,
    last_error: 'failed',
    last_error_at: 1_000,
  });
  insertOutbox.run({
    id: 'pending-outbox',
    status: 'pending',
    dead_at: null,
    last_error: null,
    last_error_at: null,
  });
  insertOutbox.run({
    id: 'sent-outbox',
    status: 'sent',
    dead_at: null,
    last_error: null,
    last_error_at: null,
  });
  db.prepare(
    `
    INSERT INTO sent_log (
      id, outbox_id, outbound_dedupe_key, channel_id, notifier_type,
      provider_message_id, provider_response_json, sent_at, created_at
    ) VALUES (
      'sent-log-1', 'sent-outbox', 'dedupe-sent', 'channel-admin', 'telegram',
      'provider-1', '{"ok":true}', 2_000, 2_000
    )
    `,
  ).run();
}
