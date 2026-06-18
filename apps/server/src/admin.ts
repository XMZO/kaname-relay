import {
  matchesRule,
  renderNotificationMessage,
  type ChannelConfig,
  type JsonObject,
  type JsonValue,
  type Logger,
  type NotificationMessage,
  type Notifier,
} from '@kaname-relay/core';
import {
  SqliteStore,
  type ChannelRecord,
  type ListOutboxFilters,
  type PatchChannelInput,
  type PatchRuleInput,
  type PatchWebhookSourceInput,
  type SaveRuleInput,
  type RuleRecord,
} from '@kaname-relay/store';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface AdminRoutesOptions {
  store: SqliteStore;
  now: () => number;
  idGenerator: () => string;
  notifiers: Record<string, Notifier | undefined>;
  triggerProcessing?: () => void | Promise<void>;
  logger?: Logger;
}

const PASSWORD_SETTING = 'admin.passwordHash';
const SESSION_SECRET_SETTING = 'admin.sessionSecret';
const SESSION_COOKIE = 'kaname_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_GENERIC_SOURCE_CONFIG = {
  inboundDedupePath: '$.id',
  eventTypePath: '$.eventType',
};

export function mountAdminRoutes(app: Hono, options: AdminRoutesOptions): void {
  app.get('/api/auth/status', async (context) =>
    context.json({
      initialized: await isInitialized(options.store),
      authenticated: await isAuthenticated(context, options),
    }),
  );

  app.post('/api/auth/init', async (context) => {
    if (await isInitialized(options.store)) {
      throw new AdminHttpError(409, 'admin password is already initialized');
    }

    const body = await readJsonObject(context);
    const password = requiredString(body.password, 'password');
    assertPassword(password);
    await options.store.setSetting(
      PASSWORD_SETTING,
      JSON.stringify({ hash: hashPassword(password) }),
      options.now(),
    );
    await setSessionCookie(context, options);

    return context.json({ ok: true }, 201);
  });

  app.post('/api/auth/login', async (context) => {
    const setting = await options.store.getSetting(PASSWORD_SETTING);

    if (!setting) {
      throw new AdminHttpError(409, 'admin password is not initialized');
    }

    const body = await readJsonObject(context);
    const password = requiredString(body.password, 'password');
    const passwordSetting = parseJsonObject(setting.valueJson, PASSWORD_SETTING);
    const hash = requiredString(passwordSetting.hash, 'password hash');

    if (!verifyPassword(password, hash)) {
      throw new AdminHttpError(401, 'invalid password');
    }

    await setSessionCookie(context, options);

    return context.json({ ok: true });
  });

  app.post('/api/auth/logout', (context) => {
    deleteCookie(context, SESSION_COOKIE, {
      path: '/',
    });

    return context.json({ ok: true });
  });

  app.get('/api/auth/me', async (context) => {
    if (!(await isAuthenticated(context, options))) {
      throw new AdminHttpError(401, 'not authenticated');
    }

    return context.json({ authenticated: true });
  });

  app.use('/api/admin/*', async (context, next) => {
    if (!(await isAuthenticated(context, options))) {
      throw new AdminHttpError(401, 'not authenticated');
    }

    await next();
  });

  app.get('/api/admin/dashboard', async (context) =>
    context.json(await options.store.getDashboardStats(options.now())),
  );

  app.get('/api/admin/sources', async (context) => {
    const sources = await options.store.listSources();

    return context.json({
      sources: sources.map(sourceResponse),
    });
  });

  app.post('/api/admin/sources', async (context) => {
    const body = await readJsonObject(context);
    const type = stringOrDefault(body.type, 'generic');
    const source = await options.store.saveSource({
      id: stringOrDefault(body.id, options.idGenerator()),
      name: requiredString(body.name, 'name'),
      type,
      enabled: booleanOrDefault(body.enabled, true),
      configJson: JSON.stringify(
        jsonObjectOrDefault(body.config, defaultSourceConfig(type), 'config'),
      ),
      secretJsonEnc: secretJsonFromBody(body),
      now: options.now(),
    });

    return context.json({ source: sourceResponse(source) }, 201);
  });

  app.patch('/api/admin/sources/:id', async (context) => {
    const body = await readJsonObject(context);
    const patch: PatchWebhookSourceInput = {
      id: context.req.param('id'),
      now: options.now(),
    };
    const name = optionalString(body.name, 'name');
    const type = optionalString(body.type, 'type');
    const enabled = optionalBoolean(body.enabled, 'enabled');

    if (name !== undefined) {
      patch.name = name;
    }

    if (type !== undefined) {
      patch.type = type;
    }

    if (enabled !== undefined) {
      patch.enabled = enabled;
    }

    if (body.config !== undefined) {
      patch.configJson = JSON.stringify(jsonObject(body.config, 'config'));
    }

    if (hasOwn(body, 'secrets')) {
      patch.secretJsonEnc = secretJsonFromBody(body);
    }

    const source = await options.store.patchSource(patch);

    if (!source) {
      throw new AdminHttpError(404, 'source not found');
    }

    return context.json({ source: sourceResponse(source) });
  });

  app.post('/api/admin/sources/:id/rotate-secret', async (context) => {
    const body = await readJsonObject(context);
    const source = await options.store.patchSource({
      id: context.req.param('id'),
      secretJsonEnc: secretJsonFromBody(body),
      now: options.now(),
    });

    if (!source) {
      throw new AdminHttpError(404, 'source not found');
    }

    return context.json({ source: sourceResponse(source) });
  });

  app.get('/api/admin/channels', async (context) => {
    const channels = await options.store.listChannels();

    return context.json({
      channels: channels.map(channelResponse),
    });
  });

  app.post('/api/admin/channels', async (context) => {
    const body = await readJsonObject(context);
    const channel = await options.store.saveChannel({
      id: stringOrDefault(body.id, options.idGenerator()),
      name: requiredString(body.name, 'name'),
      type: requiredString(body.type, 'type'),
      enabled: booleanOrDefault(body.enabled, true),
      configJson: JSON.stringify(jsonObjectOrDefault(body.config, {}, 'config')),
      secretJsonEnc: secretJsonFromBody(body),
      now: options.now(),
    });

    return context.json({ channel: channelResponse(channel) }, 201);
  });

  app.patch('/api/admin/channels/:id', async (context) => {
    const body = await readJsonObject(context);
    const patch: PatchChannelInput = {
      id: context.req.param('id'),
      now: options.now(),
    };
    const name = optionalString(body.name, 'name');
    const type = optionalString(body.type, 'type');
    const enabled = optionalBoolean(body.enabled, 'enabled');

    if (name !== undefined) {
      patch.name = name;
    }

    if (type !== undefined) {
      patch.type = type;
    }

    if (enabled !== undefined) {
      patch.enabled = enabled;
    }

    if (body.config !== undefined) {
      patch.configJson = JSON.stringify(jsonObject(body.config, 'config'));
    }

    if (hasOwn(body, 'secrets')) {
      patch.secretJsonEnc = secretJsonFromBody(body);
    }

    const channel = await options.store.patchChannel(patch);

    if (!channel) {
      throw new AdminHttpError(404, 'channel not found');
    }

    return context.json({ channel: channelResponse(channel) });
  });

  app.post('/api/admin/channels/:id/test', async (context) => {
    const channel = await options.store.getChannelRecord(context.req.param('id'));

    if (!channel) {
      throw new AdminHttpError(404, 'channel not found');
    }

    const notifier = options.notifiers[channel.type];

    if (!notifier) {
      throw new AdminHttpError(400, `notifier not registered: ${channel.type}`);
    }

    const body = await readJsonObject(context);
    const message = notificationMessageOrDefault(body.message);
    const sendContext: Parameters<Notifier['send']>[1] = {
      channel: channelConfig(channel),
      idempotencyKey: `test:${channel.id}:${options.now()}`,
      now: options.now,
      signal: AbortSignal.timeout(15_000),
    };

    if (options.logger !== undefined) {
      sendContext.logger = options.logger;
    }

    const result = await notifier.send(message, sendContext);

    return context.json({ ok: true, result });
  });

  app.get('/api/admin/rules', async (context) => {
    const rules = await options.store.listRules();
    const ruleChannels = await options.store.listRuleChannelsForRules(rules.map((rule) => rule.id));

    return context.json({
      rules: rules.map((rule) => ruleResponse(rule, ruleChannels)),
    });
  });

  app.post('/api/admin/rules', async (context) => {
    const body = await readJsonObject(context);
    const input: SaveRuleInput = {
      id: stringOrDefault(body.id, options.idGenerator()),
      name: requiredString(body.name, 'name'),
      enabled: booleanOrDefault(body.enabled, true),
      priority: numberOrDefault(body.priority, 0, 'priority'),
      matchJson: JSON.stringify(jsonObjectOrDefault(body.match, {}, 'match')),
      templateJson: JSON.stringify(jsonObjectOrDefault(body.template, {}, 'template')),
      stopOnMatch: booleanOrDefault(body.stopOnMatch, false),
      channelIds: stringArrayOrDefault(body.channelIds, []),
      now: options.now(),
    };
    const sourceId = optionalNullableString(body.sourceId, 'sourceId');

    if (sourceId !== undefined) {
      input.sourceId = sourceId;
    }

    const rule = await options.store.saveRule(input);
    const ruleChannels = await options.store.listRuleChannelsForRules([rule.id]);

    return context.json({ rule: ruleResponse(rule, ruleChannels) }, 201);
  });

  app.patch('/api/admin/rules/:id', async (context) => {
    const body = await readJsonObject(context);
    const patch: PatchRuleInput = {
      id: context.req.param('id'),
      now: options.now(),
    };
    const sourceId = optionalNullableString(body.sourceId, 'sourceId');
    const name = optionalString(body.name, 'name');
    const enabled = optionalBoolean(body.enabled, 'enabled');
    const priority = optionalNumber(body.priority, 'priority');
    const stopOnMatch = optionalBoolean(body.stopOnMatch, 'stopOnMatch');

    if (sourceId !== undefined) {
      patch.sourceId = sourceId;
    }

    if (name !== undefined) {
      patch.name = name;
    }

    if (enabled !== undefined) {
      patch.enabled = enabled;
    }

    if (priority !== undefined) {
      patch.priority = priority;
    }

    if (body.match !== undefined) {
      patch.matchJson = JSON.stringify(jsonObject(body.match, 'match'));
    }

    if (body.template !== undefined) {
      patch.templateJson = JSON.stringify(jsonObject(body.template, 'template'));
    }

    if (stopOnMatch !== undefined) {
      patch.stopOnMatch = stopOnMatch;
    }

    if (body.channelIds !== undefined) {
      patch.channelIds = stringArrayOrDefault(body.channelIds, []);
    }

    const rule = await options.store.patchRule(patch);

    if (!rule) {
      throw new AdminHttpError(404, 'rule not found');
    }

    const ruleChannels = await options.store.listRuleChannelsForRules([rule.id]);

    return context.json({ rule: ruleResponse(rule, ruleChannels) });
  });

  app.post('/api/admin/rules/:id/preview', async (context) => {
    const rule = await options.store.getRule(context.req.param('id'));

    if (!rule) {
      throw new AdminHttpError(404, 'rule not found');
    }

    const body = await readJsonObject(context);
    const payload = jsonObject(body.payload, 'payload');
    const match = parseJson(rule.matchJson, 'rule match');
    const matched = matchesRule(match, payload);
    const ruleChannels = await options.store.listRuleChannelsForRules([rule.id]);
    const messages = matched
      ? ruleChannels.map((channel) => ({
          channelId: channel.channelId,
          message: renderNotificationMessage({
            template: parseJson(rule.templateJson, 'rule template'),
            payload,
            sourceId: rule.sourceId ?? '',
            eventType: typeof payload.eventType === 'string' ? payload.eventType : null,
            ruleId: rule.id,
            channelId: channel.channelId,
            now: options.now(),
          }),
        }))
      : [];

    return context.json({ matched, messages });
  });

  app.get('/api/admin/outbox', async (context) => {
    const filters: ListOutboxFilters = {};
    const status = optionalOutboxStatus(context.req.query('status'));
    const limit = optionalPositiveInteger(context.req.query('limit'));
    const sourceId = context.req.query('sourceId');
    const channelId = context.req.query('channelId');

    if (status !== undefined) {
      filters.status = status;
    }

    if (sourceId !== undefined) {
      filters.sourceId = sourceId;
    }

    if (channelId !== undefined) {
      filters.channelId = channelId;
    }

    if (limit !== undefined) {
      filters.limit = limit;
    }

    return context.json({
      outbox: await options.store.listOutbox(filters),
    });
  });

  app.get('/api/admin/outbox/:id', async (context) => {
    const item = await options.store.getOutboxById(context.req.param('id'));

    if (!item) {
      throw new AdminHttpError(404, 'outbox item not found');
    }

    return context.json({ item });
  });

  app.post('/api/admin/outbox/:id/replay', async (context) => {
    const item = await options.store.replayOutbox(
      context.req.param('id'),
      options.idGenerator(),
      options.now(),
    );

    if (!item) {
      throw new AdminHttpError(409, 'outbox item cannot be replayed');
    }

    await Promise.resolve(options.triggerProcessing?.()).catch((error: unknown) => {
      options.logger?.error?.('admin replay processing trigger failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
    });

    return context.json({ item }, 201);
  });

  app.post('/api/admin/outbox/:id/cancel', async (context) => {
    const cancelled = await options.store.cancelOutboxAdmin(
      context.req.param('id'),
      options.now(),
      'cancelled by admin',
    );

    if (!cancelled) {
      throw new AdminHttpError(409, 'outbox item cannot be cancelled');
    }

    return context.json({ ok: true });
  });

  app.get('/api/admin/sent-log', async (context) =>
    context.json({
      sentLog: await options.store.listSentLog(
        optionalPositiveInteger(context.req.query('limit')) ?? 50,
      ),
    }),
  );
}

export class AdminHttpError extends Error {
  public constructor(
    public readonly status: 400 | 401 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'AdminHttpError';
  }
}

async function isInitialized(store: SqliteStore): Promise<boolean> {
  return (await store.getSetting(PASSWORD_SETTING)) !== null;
}

async function isAuthenticated(context: Context, options: AdminRoutesOptions): Promise<boolean> {
  const setting = await options.store.getSetting(PASSWORD_SETTING);

  if (!setting) {
    return false;
  }

  const token = getCookie(context, SESSION_COOKIE);

  if (!token) {
    return false;
  }

  const secret = await getSessionSecret(options.store, options.now());
  const payload = verifySessionToken(token, secret);

  return payload !== null && payload.exp > options.now();
}

async function setSessionCookie(context: Context, options: AdminRoutesOptions): Promise<void> {
  const secret = await getSessionSecret(options.store, options.now());
  const token = signSessionToken(
    {
      exp: options.now() + SESSION_TTL_MS,
    },
    secret,
  );

  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1_000),
  });
}

async function getSessionSecret(store: SqliteStore, now: number): Promise<string> {
  const existing = await store.getSetting(SESSION_SECRET_SETTING);

  if (existing) {
    return requiredString(
      parseJsonObject(existing.valueJson, SESSION_SECRET_SETTING).secret,
      'session secret',
    );
  }

  const secret = randomBytes(32).toString('base64url');
  await store.setSetting(SESSION_SECRET_SETTING, JSON.stringify({ secret }), now);

  return secret;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(password, salt, 64).toString('base64url');

  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [scheme, salt, expected] = encoded.split('$');

  if (scheme !== 'scrypt' || !salt || !expected) {
    return false;
  }

  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'base64url');

  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function signSessionToken(payload: { exp: number }, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');

  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token: string, secret: string): { exp: number } | null {
  const [encodedPayload, signature] = token.split('.');

  if (!encodedPayload || !signature) {
    return null;
  }

  const expected = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  const payload = JSON.parse(
    Buffer.from(encodedPayload, 'base64url').toString('utf8'),
  ) as JsonValue;

  if (!isJsonObject(payload) || typeof payload.exp !== 'number') {
    return null;
  }

  return { exp: payload.exp };
}

async function readJsonObject(context: Context): Promise<JsonObject> {
  let value: JsonValue;

  try {
    value = (await context.req.json()) as JsonValue;
  } catch (error) {
    throw new AdminHttpError(400, error instanceof Error ? 'invalid JSON body' : 'invalid body');
  }

  return jsonObject(value, 'body');
}

function sourceResponse(source: {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  configJson: string;
  secretJsonEnc: string | null;
  createdAt: number;
  updatedAt: number;
}): JsonObject {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    enabled: source.enabled,
    config: parseJsonObject(source.configJson, `source config ${source.id}`),
    hasSecret: source.secretJsonEnc !== null,
    webhookPath: `/hooks/${source.id}`,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function channelResponse(channel: ChannelRecord): JsonObject {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled,
    config: parseJsonObject(channel.configJson, `channel config ${channel.id}`),
    hasSecret: channel.secretJsonEnc !== null,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function ruleResponse(
  rule: RuleRecord,
  channels: Array<{ ruleId: string; channelId: string }>,
): JsonObject {
  return {
    id: rule.id,
    sourceId: rule.sourceId,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    match: parseJson(rule.matchJson, `rule match ${rule.id}`),
    template: parseJson(rule.templateJson, `rule template ${rule.id}`),
    stopOnMatch: rule.stopOnMatch,
    channelIds: channels
      .filter((channel) => channel.ruleId === rule.id)
      .map((channel) => channel.channelId),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function channelConfig(channel: ChannelRecord): ChannelConfig {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled,
    config: parseJsonObject(channel.configJson, `channel config ${channel.id}`),
    secrets: channel.secretJsonEnc
      ? parseJsonObject(channel.secretJsonEnc, `channel secret ${channel.id}`)
      : {},
  };
}

function notificationMessageOrDefault(value: JsonValue | undefined): NotificationMessage {
  if (value === undefined) {
    return { text: 'Test message from Kaname Relay' };
  }

  const object = jsonObject(value, 'message');
  const text = requiredString(object.text, 'message.text');
  const message: NotificationMessage = { text };

  if (typeof object.title === 'string') {
    message.title = object.title;
  }

  return message;
}

function secretJsonFromBody(body: JsonObject): string | null {
  if (!hasOwn(body, 'secrets') || body.secrets === null) {
    return null;
  }

  return JSON.stringify(jsonObject(body.secrets, 'secrets'));
}

function defaultSourceConfig(type: string): JsonObject {
  if (type === 'generic') {
    return DEFAULT_GENERIC_SOURCE_CONFIG;
  }

  if (type === 'komari') {
    return {
      defaultEventType: 'komari.notification',
    };
  }

  if (type === 'wallos') {
    return {
      defaultEventType: 'wallos.notification',
      inboundDedupePath: '$.dedupeKey',
    };
  }

  return {};
}

function assertPassword(password: string): void {
  if (password.length < 8) {
    throw new AdminHttpError(400, 'password must be at least 8 characters');
  }
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AdminHttpError(400, `${label} is required`);
  }

  return value;
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, label);
}

function optionalNullableString(
  value: JsonValue | undefined,
  label: string,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return requiredString(value, label);
}

function stringOrDefault(value: JsonValue | undefined, fallback: string): string {
  return value === undefined ? fallback : requiredString(value, 'string');
}

function booleanOrDefault(value: JsonValue | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return optionalBoolean(value, 'boolean') ?? fallback;
}

function optionalBoolean(value: JsonValue | undefined, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new AdminHttpError(400, `${label} must be a boolean`);
  }

  return value;
}

function numberOrDefault(value: JsonValue | undefined, fallback: number, label: string): number {
  return value === undefined ? fallback : (optionalNumber(value, label) ?? fallback);
}

function optionalNumber(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AdminHttpError(400, `${label} must be a number`);
  }

  return value;
}

function stringArrayOrDefault(value: JsonValue | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new AdminHttpError(400, 'expected an array of strings');
  }

  return value;
}

function jsonObjectOrDefault(
  value: JsonValue | undefined,
  fallback: JsonObject,
  label: string,
): JsonObject {
  return value === undefined ? fallback : jsonObject(value, label);
}

function jsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new AdminHttpError(400, `${label} must be a JSON object`);
  }

  return value;
}

function parseJson(raw: string, label: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON`, { cause: error });
  }
}

function parseJsonObject(raw: string, label: string): JsonObject {
  const value = parseJson(raw, label);

  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value;
}

function optionalOutboxStatus(
  value: string | undefined,
): 'pending' | 'sending' | 'sent' | 'dead' | 'cancelled' | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!['pending', 'sending', 'sent', 'dead', 'cancelled'].includes(value)) {
    throw new AdminHttpError(400, 'invalid outbox status');
  }

  return value as 'pending' | 'sending' | 'sent' | 'dead' | 'cancelled';
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AdminHttpError(400, 'expected a positive integer');
  }

  return parsed;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
