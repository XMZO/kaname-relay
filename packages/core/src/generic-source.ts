import type { JsonObject, JsonValue, NotificationMessage } from './types.js';

export interface GenericSourceConfig {
  inboundDedupePath?: string;
  dedupePath?: string;
  eventTypePath?: string;
  defaultEventType?: string;
}

export interface ParsedGenericEvent {
  inboundDedupeKey: string | null;
  eventType: string | null;
  payload: JsonObject;
}

export interface SourceParseInput {
  sourceType: string;
  payload: JsonObject;
  config: JsonObject;
  payloadHash: string;
}

export interface JsonPathResult {
  exists: boolean;
  value?: JsonValue;
}

export interface RenderMessageInput {
  template: JsonValue;
  payload: JsonObject;
  sourceId: string;
  eventType: string | null;
  ruleId: string;
  channelId: string;
  now: number;
}

const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z0-9_.$[\]-]+)\s*\}\}/g;

export function parseGenericEvent(payload: JsonObject, rawConfig: JsonObject): ParsedGenericEvent {
  const config = genericSourceConfig(rawConfig);
  const inboundDedupePath = config.inboundDedupePath ?? config.dedupePath;
  const inboundDedupeKey = inboundDedupePath
    ? jsonValueToKey(readJsonPath(payload, inboundDedupePath).value)
    : null;
  const eventTypeValue = config.eventTypePath
    ? readJsonPath(payload, config.eventTypePath).value
    : undefined;
  const eventType =
    jsonValueToKey(eventTypeValue) ?? config.defaultEventType ?? jsonValueToKey(payload.eventType);

  return {
    inboundDedupeKey,
    eventType,
    payload,
  };
}

export function isSupportedSourceType(sourceType: string): boolean {
  return sourceType === 'generic' || sourceType === 'komari' || sourceType === 'wallos';
}

export function parseWebhookSourceEvent(input: SourceParseInput): ParsedGenericEvent {
  if (input.sourceType === 'generic') {
    return parseGenericEvent(input.payload, input.config);
  }

  if (input.sourceType === 'komari') {
    return parseNotificationStyleEvent({
      sourceType: 'komari',
      payload: input.payload,
      config: input.config,
      payloadHash: input.payloadHash,
      fallbackEventType: 'komari.notification',
      messagePaths: ['message', 'text', 'body', 'content', 'description'],
      titlePaths: ['title', 'name', 'subject'],
    });
  }

  if (input.sourceType === 'wallos') {
    return parseNotificationStyleEvent({
      sourceType: 'wallos',
      payload: input.payload,
      config: input.config,
      payloadHash: input.payloadHash,
      fallbackEventType: 'wallos.notification',
      messagePaths: ['body', 'message', 'text', 'description'],
      titlePaths: ['title', 'subject', 'subscription_name', 'subscriptionName', 'name'],
    });
  }

  throw new Error(`unsupported source type: ${input.sourceType}`);
}

export function matchesRule(match: JsonValue, payload: JsonObject): boolean {
  if (match === null || match === undefined) {
    return true;
  }

  if (!isJsonObject(match)) {
    return false;
  }

  if (Object.keys(match).length === 0) {
    return true;
  }

  if (Array.isArray(match.all)) {
    return match.all.every((child) => matchesRule(child, payload));
  }

  if (Array.isArray(match.any)) {
    return match.any.some((child) => matchesRule(child, payload));
  }

  if (match.not !== undefined) {
    return !matchesRule(match.not, payload);
  }

  return matchesCondition(match, payload);
}

export function renderNotificationMessage(input: RenderMessageInput): NotificationMessage {
  const template = isJsonObject(input.template) ? input.template : {};
  const fallbackText = fallbackNotificationText(input.payload);
  const text = renderTemplateString(stringOrUndefined(template.text) ?? fallbackText, input);
  const message: NotificationMessage = {
    text: text.length > 0 ? text : fallbackText,
  };

  const title = renderOptionalString(template.title, input);
  if (title !== undefined) {
    message.title = title;
  }

  const html = renderOptionalString(template.html, input);
  if (html !== undefined) {
    message.html = html;
  }

  const markdown = renderOptionalString(template.markdown, input);
  if (markdown !== undefined) {
    message.markdown = markdown;
  }

  if (Array.isArray(template.tags)) {
    const tags = template.tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => renderTemplateString(tag, input));

    if (tags.length > 0) {
      message.tags = tags;
    }
  }

  if (isJsonObject(template.metadata)) {
    message.metadata = renderTemplateJson(template.metadata, input) as JsonObject;
  }

  return message;
}

function fallbackNotificationText(payload: JsonObject): string {
  return (
    firstString(payload, [
      'message',
      'text',
      'body',
      'content',
      'description',
      'title',
      'name',
      'subject',
    ]) ?? JSON.stringify(payload)
  );
}

export function readJsonPath(root: JsonValue, path: string): JsonPathResult {
  const segments = parsePath(path);

  if (!segments) {
    return { exists: false };
  }

  let current: JsonValue | undefined = root;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { exists: false };
      }

      current = current[index] as JsonValue;
      continue;
    }

    if (!isJsonObject(current) || !(segment in current)) {
      return { exists: false };
    }

    current = current[segment] as JsonValue;
  }

  return { exists: true, value: current };
}

interface NotificationStyleInput {
  sourceType: 'komari' | 'wallos';
  payload: JsonObject;
  config: JsonObject;
  payloadHash: string;
  fallbackEventType: string;
  messagePaths: string[];
  titlePaths: string[];
}

function parseNotificationStyleEvent(input: NotificationStyleInput): ParsedGenericEvent {
  const config = genericSourceConfig(input.config);
  const eventType = eventTypeFor(input.payload, config, input.fallbackEventType);
  // Komari emits the same title for every manual test, so treating it as a
  // stable event would make its test button work only once per retention window.
  const inboundDedupeKey = isKomariTestNotification(input)
    ? null
    : (configuredDedupeKey(input.payload, config) ??
      firstKey(input.payload, ['dedupeKey', 'dedupe_key', 'id', 'eventId', 'event_id', 'uuid']) ??
      `${input.sourceType}:${input.payloadHash}`);

  return {
    inboundDedupeKey,
    eventType,
    payload: normalizeNotificationPayload(input.payload, eventType, {
      message: firstString(input.payload, input.messagePaths),
      title: firstString(input.payload, input.titlePaths),
    }),
  };
}

function isKomariTestNotification(input: NotificationStyleInput): boolean {
  return input.sourceType === 'komari' && firstString(input.payload, ['title'])?.trim() === 'Test';
}

function configuredDedupeKey(payload: JsonObject, config: GenericSourceConfig): string | null {
  const inboundDedupePath = config.inboundDedupePath ?? config.dedupePath;

  return inboundDedupePath ? jsonValueToKey(readJsonPath(payload, inboundDedupePath).value) : null;
}

function eventTypeFor(
  payload: JsonObject,
  config: GenericSourceConfig,
  fallbackEventType: string,
): string {
  const configured = config.eventTypePath
    ? jsonValueToKey(readJsonPath(payload, config.eventTypePath).value)
    : null;

  return (
    configured ??
    jsonValueToKey(payload.eventType) ??
    jsonValueToKey(payload.type) ??
    config.defaultEventType ??
    fallbackEventType
  );
}

function normalizeNotificationPayload(
  payload: JsonObject,
  eventType: string | null,
  defaults: { title: string | undefined; message: string | undefined },
): JsonObject {
  const normalized: JsonObject = { ...payload };

  if (eventType !== null && normalized.eventType === undefined) {
    normalized.eventType = eventType;
  }

  if (defaults.title !== undefined && normalized.title === undefined) {
    normalized.title = defaults.title;
  }

  if (defaults.message !== undefined && normalized.message === undefined) {
    normalized.message = defaults.message;
  }

  return normalized;
}

function firstKey(payload: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = jsonValueToKey(payload[key]);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

function firstString(payload: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringOrUndefined(payload[key]);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function genericSourceConfig(config: JsonObject): GenericSourceConfig {
  const parsed: GenericSourceConfig = {};
  const inboundDedupePath = stringOrUndefined(config.inboundDedupePath);
  const dedupePath = stringOrUndefined(config.dedupePath);
  const eventTypePath = stringOrUndefined(config.eventTypePath);
  const defaultEventType = stringOrUndefined(config.defaultEventType);

  if (inboundDedupePath !== undefined) {
    parsed.inboundDedupePath = inboundDedupePath;
  }

  if (dedupePath !== undefined) {
    parsed.dedupePath = dedupePath;
  }

  if (eventTypePath !== undefined) {
    parsed.eventTypePath = eventTypePath;
  }

  if (defaultEventType !== undefined) {
    parsed.defaultEventType = defaultEventType;
  }

  return parsed;
}

function matchesCondition(condition: JsonObject, payload: JsonObject): boolean {
  const path = stringOrUndefined(condition.path);
  const op = stringOrUndefined(condition.op);

  if (!path || !op) {
    return false;
  }

  const actual = readJsonPath(payload, path);

  switch (op) {
    case 'eq':
      return actual.exists && jsonEquals(actual.value, condition.value);
    case 'ne':
      return !actual.exists || !jsonEquals(actual.value, condition.value);
    case 'contains':
      return actual.exists && containsValue(actual.value, condition.value);
    case 'starts_with':
      return stringPrefixOrSuffix(actual.value, condition.value, 'starts_with');
    case 'ends_with':
      return stringPrefixOrSuffix(actual.value, condition.value, 'ends_with');
    case 'in':
      return Array.isArray(condition.value)
        ? condition.value.some((candidate) => jsonEquals(actual.value, candidate))
        : false;
    case 'exists':
      return condition.value === false ? !actual.exists : actual.exists;
    default:
      throw new Error(`unsupported match op: ${op}`);
  }
}

function containsValue(actual: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.includes(expected);
  }

  if (Array.isArray(actual)) {
    return actual.some((item) => jsonEquals(item, expected));
  }

  return false;
}

function stringPrefixOrSuffix(
  actual: JsonValue | undefined,
  expected: JsonValue | undefined,
  op: 'starts_with' | 'ends_with',
): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') {
    return false;
  }

  return op === 'starts_with' ? actual.startsWith(expected) : actual.endsWith(expected);
}

function renderOptionalString(
  value: JsonValue | undefined,
  input: RenderMessageInput,
): string | undefined {
  const text = stringOrUndefined(value);

  return text === undefined ? undefined : renderTemplateString(text, input);
}

function renderTemplateString(template: string, input: RenderMessageInput): string {
  return template.replace(TEMPLATE_TOKEN, (_match, rawPath: string) => {
    const value = templateValue(input, rawPath);

    return jsonValueToDisplay(value) ?? '';
  });
}

function renderTemplateJson(value: JsonValue, input: RenderMessageInput): JsonValue {
  if (typeof value === 'string') {
    return renderTemplateString(value, input);
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateJson(item, input));
  }

  if (isJsonObject(value)) {
    const rendered: JsonObject = {};

    for (const [key, child] of Object.entries(value)) {
      rendered[key] = renderTemplateJson(child, input);
    }

    return rendered;
  }

  return value;
}

function templateValue(input: RenderMessageInput, rawPath: string): JsonValue | undefined {
  if (rawPath === 'sourceId') {
    return input.sourceId;
  }

  if (rawPath === 'eventType') {
    return input.eventType;
  }

  if (rawPath === 'ruleId') {
    return input.ruleId;
  }

  if (rawPath === 'channelId') {
    return input.channelId;
  }

  if (rawPath === 'now') {
    return input.now;
  }

  if (rawPath === 'payload') {
    return input.payload;
  }

  if (rawPath.startsWith('payload.')) {
    return readJsonPath(input.payload, rawPath.slice('payload.'.length)).value;
  }

  if (rawPath.startsWith('$.')) {
    return readJsonPath(input.payload, rawPath).value;
  }

  return undefined;
}

function parsePath(path: string): string[] | null {
  const trimmed = path.trim();
  const normalized = trimmed === '$' ? '' : trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed;

  if (normalized.length === 0) {
    return [];
  }

  const segments = normalized.split('.');

  return segments.every((segment) => segment.length > 0) ? segments : null;
}

function stringOrUndefined(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonValueToKey(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function jsonValueToDisplay(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

function jsonEquals(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
