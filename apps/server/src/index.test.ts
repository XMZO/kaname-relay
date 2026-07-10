import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { processPending, type Notifier } from '@kaname-relay/core';
import { applySqliteMigrations, SqliteProcessPendingStore, SqliteStore } from '@kaname-relay/store';
import { createNodeRuntime, createServerApp } from './index.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-server-'));
  const db = new Database(join(dir, 'test.sqlite'));
  cleanupHandles.push({ db, dir });
  applySqliteMigrations(db);
  seedWebhookChain(db);

  return {
    db,
    store: new SqliteStore(db),
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

function seedNoDedupeWebhookChain(db: Database.Database, now = 1_000): void {
  db.prepare(
    `
    INSERT INTO webhook_sources (
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (
      'source-no-key',
      'Source Without Dedupe',
      'generic',
      1,
      '{}',
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
      'rule-no-key',
      'source-no-key',
      'No Key Rule',
      1,
      5,
      '{"op":"eq","path":"$.eventType","value":"demo"}',
      '{"text":"No key {{payload.name}}"}',
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
      'rule-no-key', 'channel-1', 1, :now, :now
    )
    `,
  ).run({ now });
}

function seedBuiltinSource(
  db: Database.Database,
  input: {
    sourceId: string;
    sourceType: 'komari' | 'wallos';
    ruleId: string;
    templateText: string;
    configJson?: string;
  },
  now = 1_000,
): void {
  db.prepare(
    `
    INSERT INTO webhook_sources (
      id, name, type, enabled, config_json, created_at, updated_at
    ) VALUES (
      :source_id,
      :source_id,
      :source_type,
      1,
      :config_json,
      :now,
      :now
    )
    `,
  ).run({
    source_id: input.sourceId,
    source_type: input.sourceType,
    config_json: input.configJson ?? '{}',
    now,
  });

  db.prepare(
    `
    INSERT INTO rules (
      id, source_id, name, enabled, priority, match_json, template_json,
      stop_on_match, created_at, updated_at
    ) VALUES (
      :rule_id,
      :source_id,
      :rule_id,
      1,
      10,
      :match_json,
      :template_json,
      0,
      :now,
      :now
    )
    `,
  ).run({
    rule_id: input.ruleId,
    source_id: input.sourceId,
    match_json: '{}',
    template_json: JSON.stringify({
      text: input.templateText,
      title: '{{eventType}}',
    }),
    now,
  });

  db.prepare(
    `
    INSERT INTO rule_channels (
      rule_id, channel_id, enabled, created_at, updated_at
    ) VALUES (
      :rule_id, 'channel-1', 1, :now, :now
    )
    `,
  ).run({
    rule_id: input.ruleId,
    now,
  });
}

describe('node runtime app secret', () => {
  it('generates a persistent secret beside the SQLite database without .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-runtime-secret-'));
    const databasePath = join(dir, 'data', 'kaname-relay.sqlite');
    const secretPath = join(dir, 'data', '.kaname-app-secret');
    const previous = captureSecretEnvironment();
    let runtime: ReturnType<typeof createNodeRuntime> | undefined;

    delete process.env.APP_SECRET;
    delete process.env.KANAME_APP_SECRET;
    delete process.env.KANAME_APP_SECRET_FILE;

    try {
      runtime = createNodeRuntime({ databasePath, webDir: null, retention: false });
      expect(existsSync(secretPath)).toBe(true);
      const firstSecret = readFileSync(secretPath, 'utf8').trim();
      expect(firstSecret).toMatch(/^[a-f0-9]{64}$/u);
      runtime.stop();
      runtime = undefined;

      runtime = createNodeRuntime({ databasePath, webDir: null, retention: false });
      expect(readFileSync(secretPath, 'utf8').trim()).toBe(firstSecret);
    } finally {
      runtime?.stop();
      restoreSecretEnvironment(previous);
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('persists an existing APP_SECRET for migration away from .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaname-relay-runtime-env-secret-'));
    const databasePath = join(dir, 'kaname-relay.sqlite');
    const secretPath = join(dir, '.kaname-app-secret');
    const previous = captureSecretEnvironment();
    const configuredSecret = 'existing-app-secret-with-more-than-16-chars';
    let runtime: ReturnType<typeof createNodeRuntime> | undefined;

    process.env.APP_SECRET = configuredSecret;
    delete process.env.KANAME_APP_SECRET;
    delete process.env.KANAME_APP_SECRET_FILE;

    try {
      runtime = createNodeRuntime({ databasePath, webDir: null, retention: false });
      expect(readFileSync(secretPath, 'utf8').trim()).toBe(configuredSecret);
    } finally {
      runtime?.stop();
      restoreSecretEnvironment(previous);
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

function captureSecretEnvironment(): Record<string, string | undefined> {
  return {
    APP_SECRET: process.env.APP_SECRET,
    KANAME_APP_SECRET: process.env.KANAME_APP_SECRET,
    KANAME_APP_SECRET_FILE: process.env.KANAME_APP_SECRET_FILE,
  };
}

function restoreSecretEnvironment(previous: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

describe('server webhook endpoint', () => {
  it('serves production WebUI static files when a webDir is configured', async () => {
    const { dir, store } = createHarness();
    const webDir = join(dir, 'web');
    mkdirSync(join(webDir, 'assets'), { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Kaname</title>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'window.__kaname = true;');
    const app = createServerApp({
      store,
      webDir,
    });

    const index = await app.request('/');
    const asset = await app.request('/assets/app.js');

    expect(index.status).toBe(200);
    await expect(index.text()).resolves.toContain('Kaname');
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain('__kaname');
  });

  it('accepts a generic webhook, matches rules, renders messages, and enqueues outbox', async () => {
    const { db, store } = createHarness();
    const triggerProcessing = vi.fn();
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
      triggerProcessing,
    });

    const response = await app.request('/hooks/SOURCE-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'evt-1',
        eventType: 'demo',
        name: 'Ada',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      receivedEventId: 'id-1',
      outboxCount: 1,
    });
    expect(triggerProcessing).toHaveBeenCalledTimes(1);

    const outbox = db
      .prepare(
        `
        SELECT
          id, source_id, rule_id, channel_id, notifier_type, outbound_dedupe_key,
          event_type, message_json
        FROM outbox
        `,
      )
      .get() as {
      id: string;
      source_id: string;
      rule_id: string;
      channel_id: string;
      notifier_type: string;
      outbound_dedupe_key: string;
      event_type: string;
      message_json: string;
    };

    expect(outbox).toMatchObject({
      id: 'id-2',
      source_id: 'source-1',
      rule_id: 'rule-1',
      channel_id: 'channel-1',
      notifier_type: 'telegram',
      outbound_dedupe_key: 'source-1:evt-1:rule-1:channel-1',
      event_type: 'demo',
    });
    expect(JSON.parse(outbox.message_json)).toEqual({
      text: 'Hello Ada from demo',
      title: 'source-1',
    });
  });

  it('treats committed inbound dedupe keys as duplicates without adding outbox rows', async () => {
    const { db, store } = createHarness();
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
    });
    const body = JSON.stringify({
      id: 'evt-dup',
      eventType: 'demo',
      name: 'Ada',
    });

    const first = await app.request('/hooks/source-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body,
    });
    const second = await app.request('/hooks/source-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      receivedEventId: 'id-1',
      outboxCount: 0,
    });

    const outboxCount = db.prepare('SELECT COUNT(*) AS count FROM outbox').get() as {
      count: number;
    };
    expect(outboxCount.count).toBe(1);
  });

  it('requires a valid HMAC signature when source webhookSecret is configured', async () => {
    const { store, db } = createHarness();
    db.prepare(
      `
      UPDATE webhook_sources
      SET secret_json_enc = '{"webhookSecret":"hook-secret"}'
      WHERE id = 'source-1'
      `,
    ).run();
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
    });
    const body = JSON.stringify({
      id: 'evt-signed',
      eventType: 'demo',
      name: 'Ada',
    });
    const signature = createHmac('sha256', 'hook-secret').update(body).digest('hex');

    const missing = await app.request('/hooks/source-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body,
    });
    const signed = await app.request('/hooks/source-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kaname-signature': `sha256=${signature}`,
      },
      body,
    });

    expect(missing.status).toBe(401);
    expect(signed.status).toBe(202);
    await expect(signed.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      outboxCount: 1,
    });
  });

  it('rate-limits webhook requests per source and client address', async () => {
    const { store } = createHarness();
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
      rateLimit: {
        windowMs: 60_000,
        max: 1,
      },
    });

    const first = await app.request('/hooks/source-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '192.0.2.1',
      },
      body: JSON.stringify({
        id: 'evt-rate-1',
        eventType: 'demo',
        name: 'Ada',
      }),
    });
    const second = await app.request('/hooks/source-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '192.0.2.1',
      },
      body: JSON.stringify({
        id: 'evt-rate-2',
        eventType: 'demo',
        name: 'Ada',
      }),
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
  });

  it('keeps NULL inbound dedupe key webhooks independent end to end', async () => {
    const { db, store } = createHarness();
    seedNoDedupeWebhookChain(db);
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
    });

    const first = await app.request('/hooks/source-no-key', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        eventType: 'demo',
        name: 'First',
      }),
    });
    const second = await app.request('/hooks/source-no-key', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        eventType: 'demo',
        name: 'Second',
      }),
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      duplicate: false,
      receivedEventId: 'id-1',
      outboxCount: 1,
    });
    await expect(second.json()).resolves.toMatchObject({
      duplicate: false,
      receivedEventId: 'id-3',
      outboxCount: 1,
    });

    const receivedCount = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM received_events
        WHERE source_id = 'source-no-key'
        `,
      )
      .get() as { count: number };
    const outboxCount = db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM outbox
        WHERE source_id = 'source-no-key'
        `,
      )
      .get() as { count: number };

    expect(receivedCount.count).toBe(2);
    expect(outboxCount.count).toBe(2);
  });

  it('accepts Komari and Wallos built-in source payloads with source-specific dedupe', async () => {
    const { db, store } = createHarness();
    seedBuiltinSource(db, {
      sourceId: 'source-komari',
      sourceType: 'komari',
      ruleId: 'rule-komari',
      templateText: 'Komari {{payload.title}}: {{payload.message}}',
    });
    seedBuiltinSource(db, {
      sourceId: 'source-wallos',
      sourceType: 'wallos',
      ruleId: 'rule-wallos',
      templateText: 'Wallos {{payload.title}}: {{payload.message}}',
      configJson: '{"inboundDedupePath":"$.dedupeKey"}',
    });
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
    });
    const komariBody = JSON.stringify({
      title: 'Node down',
      message: 'node-1 is offline',
    });

    const firstKomari = await app.request('/hooks/source-komari', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: komariBody,
    });
    const duplicateKomari = await app.request('/hooks/source-komari', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: komariBody,
    });
    const wallos = await app.request('/hooks/source-wallos', {
      method: 'POST',
      body: JSON.stringify({
        eventType: 'wallos.payment_due',
        dedupeKey: 'wallos:payment:netflix:2026-07-01:5',
        title: 'Netflix',
        message: 'Netflix renews in 5 days for 10.00 USD',
        subscriptionName: 'Netflix',
        date: '2026-07-01',
        daysUntil: '5',
      }),
    });

    expect(firstKomari.status).toBe(202);
    expect(duplicateKomari.status).toBe(202);
    expect(wallos.status).toBe(202);
    await expect(duplicateKomari.json()).resolves.toMatchObject({
      duplicate: true,
      outboxCount: 0,
    });

    const rows = db
      .prepare(
        `
        SELECT source_id, inbound_dedupe_key, message_json
        FROM outbox
        WHERE source_id IN ('source-komari', 'source-wallos')
        ORDER BY source_id ASC
        `,
      )
      .all() as Array<{
      source_id: string;
      inbound_dedupe_key: string;
      message_json: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.source_id).toBe('source-komari');
    expect(rows[0]?.inbound_dedupe_key).toMatch(/^komari:/);
    expect(JSON.parse(rows[0]?.message_json ?? '{}')).toEqual({
      text: 'Komari Node down: node-1 is offline',
      title: 'komari.notification',
    });
    expect(rows[1]).toMatchObject({
      source_id: 'source-wallos',
      inbound_dedupe_key: 'wallos:payment:netflix:2026-07-01:5',
    });
    expect(JSON.parse(rows[1]?.message_json ?? '{}')).toEqual({
      text: 'Wallos Netflix: Netflix renews in 5 days for 10.00 USD',
      title: 'wallos.payment_due',
    });
  });

  it('processes a posted webhook through the SQLite process store seam into sent_log', async () => {
    const { db, store } = createHarness();
    let id = 0;
    const app = createServerApp({
      store,
      now: () => 10_000,
      idGenerator: () => `id-${++id}`,
    });

    const response = await app.request('/hooks/source-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'evt-seam',
        eventType: 'demo',
        name: 'Ada',
      }),
    });

    expect(response.status).toBe(202);

    const processStore = new SqliteProcessPendingStore(store);
    const send = vi.fn<Notifier['send']>().mockResolvedValue({
      providerMessageId: 'provider-seam',
      providerResponseJson: {
        ok: true,
      },
    });

    const result = await processPending({
      store: processStore,
      notifiers: {
        telegram: {
          type: 'telegram',
          send,
        },
      },
      now: () => 20_000,
      idGenerator: () => 'lease-seam',
      limit: 10,
      recoverLimit: 10,
      leaseMs: 90_000,
      sendTimeoutMs: 1_000,
      maxConcurrency: 1,
      backoff: {
        initialDelayMs: 30_000,
        multiplier: 2,
        maxDelayMs: 1_800_000,
      },
      random: () => 0.5,
    });

    expect(result).toMatchObject({
      claimed: 1,
      sent: 1,
      retried: 0,
      dead: 0,
      leaseLost: 0,
      errored: 0,
    });
    expect(send).toHaveBeenCalledWith(
      {
        text: 'Hello Ada from demo',
        title: 'source-1',
      },
      expect.objectContaining({
        idempotencyKey: 'source-1:evt-seam:rule-1:channel-1',
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
      outbound_dedupe_key: 'source-1:evt-seam:rule-1:channel-1',
      provider_message_id: 'provider-seam',
      provider_response_json: '{"ok":true}',
    });

    const outbox = db.prepare('SELECT status, sent_at FROM outbox WHERE id = ?').get('id-2') as {
      status: string;
      sent_at: number;
    };
    expect(outbox).toEqual({
      status: 'sent',
      sent_at: 20_000,
    });
  });
});
