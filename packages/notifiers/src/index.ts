import type {
  JsonObject,
  JsonValue,
  NotificationMessage,
  Notifier,
  NotifierResult,
} from '@kaname-relay/core';

type FetchLike = typeof fetch;

export class TelegramNotifierError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'TelegramNotifierError';
  }
}

export class ResendNotifierError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'ResendNotifierError';
  }
}

export class WebhookNotifierError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'WebhookNotifierError';
  }
}

export function createTelegramNotifier(fetchFn: FetchLike = fetch): Notifier {
  return {
    type: 'telegram',
    async send(message, context) {
      const botToken = requiredString(context.channel.secrets.botToken, 'telegram botToken');
      const chatId = requiredString(
        context.channel.config.chatId ?? context.channel.secrets.chatId,
        'telegram chatId',
      );
      const telegramMetadata = telegramMessageMetadata(message);
      const parseMode =
        optionalString(context.channel.config.parseMode) ??
        optionalString(telegramMetadata?.parseMode);
      const disableWebPagePreview =
        typeof context.channel.config.disableWebPagePreview === 'boolean'
          ? context.channel.config.disableWebPagePreview
          : typeof telegramMetadata?.disableWebPagePreview === 'boolean'
            ? telegramMetadata.disableWebPagePreview
            : undefined;
      const inlineKeyboard = telegramInlineKeyboard(telegramMetadata?.inlineKeyboard);

      const body: JsonObject = {
        chat_id: chatId,
        text: message.text,
      };

      if (parseMode) {
        body.parse_mode = parseMode;
      }

      if (disableWebPagePreview !== undefined) {
        body.disable_web_page_preview = disableWebPagePreview;
      }

      if (inlineKeyboard !== undefined) {
        body.reply_markup = {
          inline_keyboard: inlineKeyboard,
        };
      }

      const response = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: context.signal,
      });
      const responseBody = await readTelegramResponse(response);

      if (!response.ok) {
        throw new TelegramNotifierError(
          telegramErrorMessage(response.status, responseBody),
          isRetryableStatus(response.status),
          response.status,
          optionalString(responseBody.error_code),
        );
      }

      const result: NotifierResult = {
        providerResponseJson: responseBody,
      };

      const messageId = providerMessageId(responseBody);

      if (messageId !== undefined) {
        result.providerMessageId = messageId;
      }

      return result;
    },
  };
}

export function createResendNotifier(fetchFn: FetchLike = fetch): Notifier {
  return {
    type: 'resend',
    async send(message, context) {
      const apiKey = requiredString(context.channel.secrets.apiKey, 'resend apiKey');
      const from = requiredString(context.channel.config.from, 'resend from');
      const to = requiredStringOrStringArray(context.channel.config.to, 'resend to');
      const subject =
        message.title ??
        optionalString(context.channel.config.subject) ??
        'Kaname Relay notification';
      const replyTo = optionalString(context.channel.config.replyTo);
      const endpoint =
        optionalString(context.channel.config.endpoint) ?? 'https://api.resend.com/emails';
      const headers: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      };
      const body: JsonObject = {
        from,
        to,
        subject,
        text: message.text,
      };

      if (context.idempotencyKey.length > 0) {
        headers['idempotency-key'] = context.idempotencyKey;
      }

      if (replyTo !== undefined) {
        body.reply_to = replyTo;
      }

      if (message.html !== undefined) {
        body.html = message.html;
      }

      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: context.signal,
      });
      const responseBody = await readResendResponse(response);

      if (!response.ok) {
        throw new ResendNotifierError(
          resendErrorMessage(response.status, responseBody),
          isRetryableStatus(response.status),
          response.status,
          optionalString(responseBody.name),
        );
      }

      const result: NotifierResult = {
        providerResponseJson: responseBody,
      };
      const messageId = providerMessageId(responseBody);

      if (messageId !== undefined) {
        result.providerMessageId = messageId;
      }

      return result;
    },
  };
}

export function createWebhookNotifier(fetchFn: FetchLike = fetch): Notifier {
  return {
    type: 'webhook',
    async send(message, context) {
      const url = webhookRequiredString(context.channel.config.url, 'webhook url');
      const method = optionalString(context.channel.config.method)?.toUpperCase() ?? 'POST';
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };

      mergeHeaders(headers, context.channel.config.headers);
      mergeHeaders(headers, context.channel.secrets.headers);

      const idempotencyHeader = optionalString(context.channel.config.idempotencyHeader);

      if (idempotencyHeader && context.idempotencyKey.length > 0) {
        headers[idempotencyHeader.toLowerCase()] = context.idempotencyKey;
      }

      const response = await fetchFn(url, {
        method,
        headers,
        body: JSON.stringify(webhookBody(message)),
        signal: context.signal,
      });
      const responseBody = await readWebhookResponse(response);

      if (!response.ok) {
        throw new WebhookNotifierError(
          webhookErrorMessage(response.status, responseBody),
          isRetryableStatus(response.status),
          response.status,
        );
      }

      const result: NotifierResult = {};

      if (responseBody !== undefined) {
        result.providerResponseJson = responseBody;

        const messageId = providerMessageId(responseBody);

        if (messageId !== undefined) {
          result.providerMessageId = messageId;
        }
      }

      return result;
    },
  };
}

async function readTelegramResponse(response: Response): Promise<JsonObject> {
  const text = await response.text();

  if (text.length === 0) {
    return {};
  }

  const parsed = JSON.parse(text) as JsonValue;

  if (!isJsonObject(parsed)) {
    throw new TelegramNotifierError('telegram returned a non-object response', true);
  }

  return parsed;
}

async function readResendResponse(response: Response): Promise<JsonObject> {
  const text = await response.text();

  if (text.length === 0) {
    return {};
  }

  const parsed = JSON.parse(text) as JsonValue;

  if (!isJsonObject(parsed)) {
    throw new ResendNotifierError('resend returned a non-object response', true);
  }

  return parsed;
}

function telegramErrorMessage(status: number, responseBody: JsonObject): string {
  const description = optionalString(responseBody.description);

  return description
    ? `telegram send failed (${status}): ${description}`
    : `telegram send failed (${status})`;
}

function telegramMessageMetadata(message: NotificationMessage): JsonObject | undefined {
  const telegram = message.metadata?.telegram;
  return isJsonObject(telegram) ? telegram : undefined;
}

function telegramInlineKeyboard(value: JsonValue | undefined): JsonObject[][] | undefined {
  if (!Array.isArray(value)) return undefined;

  const rows = value.slice(0, 20).flatMap((row) => {
    if (!Array.isArray(row)) return [];

    const buttons = row.slice(0, 8).flatMap((button) => {
      if (!isJsonObject(button)) return [];
      const text = optionalString(button.text);
      const url = optionalString(button.url);
      return text && url ? [{ text, url }] : [];
    });

    return buttons.length > 0 ? [buttons] : [];
  });

  return rows.length > 0 ? rows : undefined;
}

function resendErrorMessage(status: number, responseBody: JsonObject): string {
  const message = optionalString(responseBody.message);

  return message ? `resend send failed (${status}): ${message}` : `resend send failed (${status})`;
}

function webhookBody(message: NotificationMessage): JsonObject {
  const body: JsonObject = {
    text: message.text,
  };

  if (message.title !== undefined) {
    body.title = message.title;
  }

  if (message.html !== undefined) {
    body.html = message.html;
  }

  if (message.markdown !== undefined) {
    body.markdown = message.markdown;
  }

  if (message.tags !== undefined) {
    body.tags = message.tags;
  }

  if (message.metadata !== undefined) {
    body.metadata = message.metadata;
  }

  if (message.render !== undefined) {
    body.render = message.render as unknown as JsonObject;
  }

  return body;
}

function mergeHeaders(target: Record<string, string>, value: JsonValue | undefined): void {
  if (!isJsonObject(value)) {
    return;
  }

  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string') {
      target[key.toLowerCase()] = headerValue;
    }
  }
}

async function readWebhookResponse(response: Response): Promise<JsonObject | undefined> {
  const text = await response.text();

  if (text.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as JsonValue;

    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function webhookErrorMessage(status: number, responseBody: JsonObject | undefined): string {
  const detail = responseBody
    ? (optionalString(responseBody.message) ?? optionalString(responseBody.error))
    : undefined;

  return detail ? `webhook send failed (${status}): ${detail}` : `webhook send failed (${status})`;
}

function webhookRequiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebhookNotifierError(`missing ${label}`, false);
  }

  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function providerMessageId(responseBody: JsonObject): string | undefined {
  const id = responseBody.id;

  if (typeof id === 'number' || typeof id === 'string') {
    return String(id);
  }

  const result = responseBody.result;

  if (!isJsonObject(result)) {
    return undefined;
  }

  const messageId = result.message_id;

  return typeof messageId === 'number' || typeof messageId === 'string'
    ? String(messageId)
    : undefined;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TelegramNotifierError(`missing ${label}`, false);
  }

  return value;
}

function requiredStringOrStringArray(
  value: JsonValue | undefined,
  label: string,
): string | string[] {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
    return value;
  }

  throw new ResendNotifierError(`missing ${label}`, false);
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
