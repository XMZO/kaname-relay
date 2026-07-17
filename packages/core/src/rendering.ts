import type {
  JsonObject,
  JsonValue,
  NotificationImageDelivery,
  NotificationImageFormat,
  NotificationRenderRequest,
} from './types.js';

const IMAGE_FORMATS = new Set<NotificationImageFormat>(['png', 'jpeg', 'webp']);
const DELIVERY_MODES = new Set<NotificationImageDelivery>([
  'attachment',
  'replace-text',
  'text-and-image',
]);

export function parseNotificationRenderRequest(value: JsonValue): NotificationRenderRequest {
  if (!isJsonObject(value)) {
    throw new Error('notification render request must be an object');
  }

  const request: NotificationRenderRequest = {
    renderer: requiredString(value.renderer, 'notification render renderer'),
    html: requiredString(value.html, 'notification render html'),
  };
  const format = optionalString(value.format);
  const delivery = optionalString(value.delivery);

  if (format !== undefined) {
    if (!IMAGE_FORMATS.has(format as NotificationImageFormat)) {
      throw new Error(`unsupported notification image format: ${format}`);
    }
    request.format = format as NotificationImageFormat;
  }

  if (delivery !== undefined) {
    if (!DELIVERY_MODES.has(delivery as NotificationImageDelivery)) {
      throw new Error(`unsupported notification image delivery: ${delivery}`);
    }
    request.delivery = delivery as NotificationImageDelivery;
  }

  copyOptionalString(value, request, 'filename');
  copyOptionalString(value, request, 'selector');
  copyOptionalString(value, request, 'background');
  copyOptionalBoolean(value, request, 'fullPage');
  copyOptionalNumber(value, request, 'width', 16, 4096);
  copyOptionalNumber(value, request, 'height', 16, 16_384);
  copyOptionalNumber(value, request, 'deviceScaleFactor', 0.5, 4);
  copyOptionalNumber(value, request, 'quality', 1, 100);

  if (value.options !== undefined) {
    if (!isJsonObject(value.options)) {
      throw new Error('notification render options must be an object');
    }
    request.options = value.options;
  }

  return request;
}

function copyOptionalString<K extends 'filename' | 'selector' | 'background'>(
  source: JsonObject,
  target: NotificationRenderRequest,
  key: K,
): void {
  const value = optionalString(source[key]);
  if (value !== undefined) target[key] = value;
}

function copyOptionalBoolean(
  source: JsonObject,
  target: NotificationRenderRequest,
  key: 'fullPage',
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`notification render ${key} must be a boolean`);
  target[key] = value;
}

function copyOptionalNumber<K extends 'width' | 'height' | 'deviceScaleFactor' | 'quality'>(
  source: JsonObject,
  target: NotificationRenderRequest,
  key: K,
  minimum: number,
  maximum: number,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`notification render ${key} must be between ${minimum} and ${maximum}`);
  }
  target[key] = value;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
