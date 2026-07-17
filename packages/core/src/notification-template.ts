import { Liquid } from 'liquidjs';

import {
  countryFlag,
  formatBeijingTime,
  formatMemory,
  formatTraffic,
  hideIp,
  komariEventInfo,
  normalizeKomariEventName,
  trafficCycle,
  translateKomariMessage,
} from './komari-format.js';
import type { JsonObject, JsonValue } from './types.js';

export type NotificationTemplateEngine = 'simple' | 'liquid';

export interface NotificationTemplateContext {
  payload: JsonObject;
  sourceId: string;
  eventType: string | null;
  ruleId: string;
  channelId: string;
  now: number;
  vars: JsonObject;
}

const MAX_TEMPLATE_SOURCE_LENGTH = 32_768;
const MAX_RENDERED_OUTPUT_LENGTH = 131_072;

const liquid = new Liquid({
  strictFilters: true,
  strictVariables: false,
  ownPropertyOnly: true,
  lenientIf: true,
  dynamicPartials: false,
  templates: {},
  parseLimit: MAX_TEMPLATE_SOURCE_LENGTH,
  renderLimit: 150,
  memoryLimit: 1_000_000,
});

liquid.registerFilter('beijing_time', (value, now) => formatBeijingTime(value, now));
liquid.registerFilter('country_flag', (value) => countryFlag(value));
liquid.registerFilter('format_memory', (value) => formatMemory(value));
liquid.registerFilter('format_traffic', (value) => formatTraffic(value));
liquid.registerFilter('hide_ip', (value) => hideIp(value));
liquid.registerFilter('komari_event', (value, message) => komariEventInfo(value, message));
liquid.registerFilter('komari_event_name', (value, message) =>
  normalizeKomariEventName(value, message),
);
liquid.registerFilter(
  'komari_event_title',
  (value, message) => komariEventInfo(value, message).title,
);
liquid.registerFilter('komari_translate', (value) => translateKomariMessage(value));
liquid.registerFilter('traffic_cycle', (value) => trafficCycle(value));

export function notificationTemplateEngine(template: JsonObject): NotificationTemplateEngine {
  const engine = template.engine;

  if (engine === undefined || engine === 'simple') return 'simple';
  if (engine === 'liquid') return 'liquid';
  throw new Error(`unsupported notification template engine: ${String(engine)}`);
}

export function notificationTemplateVariables(template: JsonObject): JsonObject {
  const variables = template.variables;

  if (variables === undefined) return {};
  if (isJsonObject(variables)) return variables;
  throw new Error('notification template variables must be an object');
}

export function renderLiquidTemplate(source: string, context: NotificationTemplateContext): string {
  assertTemplateLength(source);

  try {
    const output = String(
      liquid.parseAndRenderSync(source, context, {
        templateLimit: 20_000,
        renderLimit: 150,
        memoryLimit: 1_000_000,
      }),
    ).trim();

    if (output.length > MAX_RENDERED_OUTPUT_LENGTH) {
      throw new Error(`rendered output exceeds ${MAX_RENDERED_OUTPUT_LENGTH} characters`);
    }

    return output;
  } catch (error) {
    throw notificationTemplateError(error);
  }
}

export function validateNotificationTemplate(template: JsonObject): void {
  const engine = notificationTemplateEngine(template);
  notificationTemplateVariables(template);

  for (const field of ['text', 'title', 'html', 'markdown'] as const) {
    const value = template[field];
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`notification template ${field} must be a string`);
    }
  }

  if (template.tags !== undefined && !Array.isArray(template.tags)) {
    throw new Error('notification template tags must be an array');
  }

  if (template.metadata !== undefined && !isJsonObject(template.metadata)) {
    throw new Error('notification template metadata must be an object');
  }

  if (template.render !== undefined) {
    if (!isJsonObject(template.render)) {
      throw new Error('notification template render must be an object');
    }
    if (typeof template.render.renderer !== 'string') {
      throw new Error('notification template render.renderer must be a string');
    }
    if (typeof template.render.html !== 'string') {
      throw new Error('notification template render.html must be a string');
    }
  }

  if (engine !== 'liquid') return;

  for (const value of renderableTemplateValues(template)) {
    assertTemplateLength(value);
    try {
      liquid.parse(value);
    } catch (error) {
      throw notificationTemplateError(error);
    }
  }
}

function* renderableTemplateValues(template: JsonObject): Generator<string> {
  for (const field of ['text', 'title', 'html', 'markdown'] as const) {
    const value = template[field];
    if (typeof value === 'string') yield value;
  }

  if (Array.isArray(template.tags)) yield* stringsInValue(template.tags);
  if (isJsonObject(template.metadata)) yield* stringsInValue(template.metadata);
  if (isJsonObject(template.render)) yield* stringsInValue(template.render);
}

function* stringsInValue(value: JsonValue): Generator<string> {
  if (typeof value === 'string') {
    yield value;
    return;
  }

  if (Array.isArray(value)) {
    for (const child of value) yield* stringsInValue(child);
    return;
  }

  if (isJsonObject(value)) {
    for (const child of Object.values(value)) yield* stringsInValue(child);
  }
}

function assertTemplateLength(source: string): void {
  if (source.length > MAX_TEMPLATE_SOURCE_LENGTH) {
    throw new Error(`notification template exceeds ${MAX_TEMPLATE_SOURCE_LENGTH} characters`);
  }
}

function notificationTemplateError(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'unknown template error';
  return new Error(`notification template error: ${message}`);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
