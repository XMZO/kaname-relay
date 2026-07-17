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

interface AuthSession {
  cookie: string;
  csrf: string;
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

async function initialize(app: ReturnType<typeof createServerApp>): Promise<AuthSession> {
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

  const setCookie = response.headers.get('set-cookie') ?? '';
  const session = cookiePair(setCookie, 'kaname_session');
  const csrf = cookiePair(setCookie, 'kaname_csrf');

  if (!session || !csrf) {
    throw new Error('expected session and csrf cookies');
  }

  return {
    cookie: `${session}; ${csrf}`,
    csrf: csrf.slice('kaname_csrf='.length),
  };
}

function cookiePair(header: string, name: string): string | null {
  const match = new RegExp(`${name}=[^;,]+`).exec(header);

  return match ? match[0] : null;
}

function adminHeaders(auth: AuthSession, contentType = false): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: auth.cookie,
    'x-kaname-csrf': auth.csrf,
  };

  if (contentType) {
    headers['content-type'] = 'application/json';
  }

  return headers;
}

describe('admin API', () => {
  it('initializes auth and manages sources, channels, templates, rules, preview, and test sends', async () => {
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

    const auth = await initialize(app);

    const csrfDenied = await app.request('/api/admin/sources', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: auth.cookie,
      },
      body: JSON.stringify({
        id: 'csrf-denied',
        name: 'CSRF Denied',
      }),
    });
    expect(csrfDenied.status).toBe(401);

    const sourceResponse = await app.request('/api/admin/sources', {
      method: 'POST',
      headers: adminHeaders(auth, true),
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
      headers: adminHeaders(auth, true),
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

    const templateResponse = await app.request('/api/admin/templates', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'template-ui',
        name: 'UI Template',
        template: {
          text: 'Shared {{payload.name}}',
          title: '{{eventType}}',
        },
        samplePayload: {
          eventType: 'demo.created',
          name: 'Ada',
        },
      }),
    });
    expect(templateResponse.status).toBe(201);
    await expect(templateResponse.json()).resolves.toMatchObject({
      template: {
        id: 'template-ui',
        name: 'UI Template',
        template: {
          text: 'Shared {{payload.name}}',
        },
      },
    });

    const templatePreview = await app.request('/api/admin/templates/preview', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        template: {
          text: 'Preview {{payload.name}}',
        },
        payload: {
          name: 'Ada',
        },
      }),
    });
    expect(templatePreview.status).toBe(200);
    await expect(templatePreview.json()).resolves.toEqual({
      message: {
        text: 'Preview Ada',
      },
    });

    const ruleResponse = await app.request('/api/admin/rules', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'rule-ui',
        sourceId: 'source-ui',
        templateId: 'template-ui',
        name: 'UI Rule',
        priority: 10,
        match: {
          op: 'starts_with',
          path: '$.eventType',
          value: 'demo',
        },
        template: {
          text: 'Inline {{payload.name}}',
          title: '{{eventType}}',
        },
        channelIds: ['channel-ui'],
      }),
    });
    expect(ruleResponse.status).toBe(201);

    const preview = await app.request('/api/admin/rules/rule-ui/preview', {
      method: 'POST',
      headers: adminHeaders(auth, true),
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
            text: 'Shared Ada',
            title: 'demo.created',
          },
        },
      ],
    });

    const updateTemplate = await app.request('/api/admin/templates/template-ui', {
      method: 'PATCH',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        name: 'UI Template Updated',
        template: {
          text: 'Updated {{payload.name}}',
          title: '{{eventType}}',
        },
      }),
    });
    expect(updateTemplate.status).toBe(200);

    const updatedPreview = await app.request('/api/admin/rules/rule-ui/preview', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        payload: {
          eventType: 'demo.updated',
          name: 'Grace',
        },
      }),
    });
    await expect(updatedPreview.json()).resolves.toMatchObject({
      messages: [{ message: { text: 'Updated Grace' } }],
    });

    const draftPreview = await app.request('/api/admin/rules/preview', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        ruleId: 'draft-rule',
        sourceId: 'source-ui',
        match: {},
        template: {
          engine: 'liquid',
          text: '{% for item in payload.items %}{{ item.name }}{% unless forloop.last %}, {% endunless %}{% endfor %}',
        },
        channelIds: ['channel-ui'],
        payload: {
          items: [{ name: 'Ada' }, { name: 'Grace' }],
        },
      }),
    });
    expect(draftPreview.status).toBe(200);
    await expect(draftPreview.json()).resolves.toEqual({
      matched: true,
      messages: [
        {
          channelId: 'channel-ui',
          message: {
            text: 'Ada, Grace',
          },
        },
      ],
    });

    const testSend = await app.request('/api/admin/channels/channel-ui/test', {
      method: 'POST',
      headers: adminHeaders(auth, true),
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

    const deleteTemplate = await app.request('/api/admin/templates/template-ui', {
      method: 'DELETE',
      headers: adminHeaders(auth),
    });
    expect(deleteTemplate.status).toBe(200);
    await expect(store.getRule('rule-ui')).resolves.toMatchObject({ templateId: null });
  });

  it('rejects rules that reference missing sources or channels with a readable 400', async () => {
    const { store } = createHarness();
    const app = createServerApp({
      store,
      now: () => 12_000,
      idGenerator: () => 'generated-id',
    });
    const auth = await initialize(app);

    const missingSource = await app.request('/api/admin/rules', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'rule-missing-source',
        sourceId: 'source-does-not-exist',
        name: 'Missing source',
        match: {},
        template: { text: 'test' },
        channelIds: [],
      }),
    });
    expect(missingSource.status).toBe(400);
    await expect(missingSource.json()).resolves.toEqual({
      error: 'unknown source ID: source-does-not-exist',
    });

    await app.request('/api/admin/sources', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'source-valid',
        name: 'Valid source',
        type: 'komari',
        config: {},
      }),
    });
    const missingChannel = await app.request('/api/admin/rules', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'rule-missing-channel',
        sourceId: 'source-valid',
        name: 'Missing channel',
        match: {},
        template: { text: 'test' },
        channelIds: ['5370698809'],
      }),
    });
    expect(missingChannel.status).toBe(400);
    await expect(missingChannel.json()).resolves.toEqual({
      error: 'unknown channel IDs: 5370698809',
    });

    const missingTemplate = await app.request('/api/admin/rules', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'rule-missing-template',
        sourceId: 'source-valid',
        templateId: 'template-does-not-exist',
        name: 'Missing template',
        match: {},
        template: { text: 'fallback' },
        channelIds: [],
      }),
    });
    expect(missingTemplate.status).toBe(400);
    await expect(missingTemplate.json()).resolves.toEqual({
      error: 'unknown notification template ID: template-does-not-exist',
    });
    await expect(store.getRule('rule-missing-source')).resolves.toBeNull();
    await expect(store.getRule('rule-missing-channel')).resolves.toBeNull();
    await expect(store.getRule('rule-missing-template')).resolves.toBeNull();
  });

  it('rejects invalid notification templates before saving a rule', async () => {
    const { store } = createHarness();
    const app = createServerApp({
      store,
      now: () => 12_250,
      idGenerator: () => 'generated-id',
    });
    const auth = await initialize(app);

    const response = await app.request('/api/admin/rules', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'rule-invalid-template',
        name: 'Invalid template',
        match: {},
        template: {
          engine: 'liquid',
          text: '{% if payload.ok %}',
        },
        channelIds: [],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('notification template error'),
    });
    await expect(store.getRule('rule-invalid-template')).resolves.toBeNull();
  });

  it('applies built-in Komari and Wallos source defaults when config is omitted', async () => {
    const { store } = createHarness();
    const app = createServerApp({
      store,
      now: () => 12_500,
      idGenerator: () => 'generated-id',
    });
    const auth = await initialize(app);

    const komari = await app.request('/api/admin/sources', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'source-komari-default',
        name: 'Komari',
        type: 'komari',
      }),
    });
    expect(komari.status).toBe(201);
    await expect(komari.json()).resolves.toMatchObject({
      source: {
        type: 'komari',
        config: {
          defaultEventType: 'komari.notification',
          eventTypePath: '$.event',
          inboundDedupePath: '$.dedupeKey',
        },
      },
    });

    const caseCollision = await app.request('/api/admin/sources', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'SOURCE-KOMARI-DEFAULT',
        name: 'Komari duplicate',
        type: 'komari',
      }),
    });
    expect(caseCollision.status).toBe(409);
    await expect(caseCollision.json()).resolves.toEqual({
      error: 'source ID already exists: source-komari-default',
    });

    const wallos = await app.request('/api/admin/sources', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'source-wallos-default',
        name: 'Wallos',
        type: 'wallos',
      }),
    });
    expect(wallos.status).toBe(201);
    await expect(wallos.json()).resolves.toMatchObject({
      source: {
        type: 'wallos',
        config: {
          defaultEventType: 'wallos.notification',
          inboundDedupePath: '$.dedupeKey',
        },
      },
    });
  });

  it('toggles a channel without replacing its config or secrets', async () => {
    const { store } = createHarness();
    const app = createServerApp({
      store,
      now: () => 13_000,
      idGenerator: () => 'generated-id',
    });
    const auth = await initialize(app);

    await app.request('/api/admin/channels', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        id: 'channel-toggle',
        name: 'Toggle channel',
        type: 'telegram',
        config: { chatId: '5370698809' },
        secrets: { botToken: 'keep-this-token' },
      }),
    });
    const before = await store.getChannelRecord('channel-toggle');

    const disabled = await app.request('/api/admin/channels/channel-toggle', {
      method: 'PATCH',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      channel: {
        id: 'channel-toggle',
        enabled: false,
        config: { chatId: '5370698809' },
        hasSecret: true,
      },
    });

    const afterDisable = await store.getChannelRecord('channel-toggle');
    expect(afterDisable?.configJson).toBe(before?.configJson);
    expect(afterDisable?.secretJsonEnc).toBe(before?.secretJsonEnc);

    const enabled = await app.request('/api/admin/channels/channel-toggle', {
      method: 'PATCH',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      channel: {
        id: 'channel-toggle',
        enabled: true,
      },
    });
  });

  it('manages settings and changes the admin password', async () => {
    const { store } = createHarness();
    const app = createServerApp({
      store,
      now: () => 30_000,
      idGenerator: () => 'id-settings',
    });
    const auth = await initialize(app);

    const defaults = await app.request('/api/admin/settings', {
      headers: {
        cookie: auth.cookie,
      },
    });
    expect(defaults.status).toBe(200);
    await expect(defaults.json()).resolves.toMatchObject({
      retention: {
        sentRetentionDays: 30,
        receivedRetentionDays: 30,
        cleanupLimit: 100,
      },
      retry: {
        maxAttempts: 10,
        initialDelayMs: 30_000,
      },
    });

    const saved = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        retention: {
          sentRetentionDays: 7,
          receivedRetentionDays: 14,
          cleanupLimit: 25,
        },
        retry: {
          maxAttempts: 3,
          initialDelayMs: 1_000,
          multiplier: 2,
          maxDelayMs: 60_000,
          jitterRatio: 0,
          leaseMs: 30_000,
          sendTimeoutMs: 5_000,
        },
      }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      retention: {
        sentRetentionDays: 7,
        receivedRetentionDays: 14,
        cleanupLimit: 25,
      },
      retry: {
        maxAttempts: 3,
        sendTimeoutMs: 5_000,
      },
    });

    const password = await app.request('/api/admin/password', {
      method: 'POST',
      headers: adminHeaders(auth, true),
      body: JSON.stringify({
        currentPassword: 'correct horse battery staple',
        newPassword: 'new correct horse battery staple',
      }),
    });
    expect(password.status).toBe(200);

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        password: 'new correct horse battery staple',
      }),
    });
    expect(login.status).toBe(200);
  });

  it('lists outbox and sent-log rows, cancels pending work, and replays dead work', async () => {
    const { db, store } = createHarness();
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 20_000,
      idGenerator: () => `replay-${++id}`,
    });
    const auth = await initialize(app);

    seedAdminOutbox(db);

    const dashboard = await app.request('/api/admin/dashboard', {
      headers: {
        cookie: auth.cookie,
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
        cookie: auth.cookie,
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

    const filteredOutbox = await app.request(
      '/api/admin/outbox?sourceId=source-admin&channelId=channel-admin&createdFrom=1000&createdTo=1000',
      {
        headers: {
          cookie: auth.cookie,
        },
      },
    );
    expect(filteredOutbox.status).toBe(200);
    await expect(filteredOutbox.json()).resolves.toMatchObject({
      outbox: expect.arrayContaining([
        expect.objectContaining({
          id: 'dead-outbox',
        }),
      ]),
    });

    const replay = await app.request('/api/admin/outbox/dead-outbox/replay', {
      method: 'POST',
      headers: adminHeaders(auth),
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
      headers: adminHeaders(auth),
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
        cookie: auth.cookie,
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
