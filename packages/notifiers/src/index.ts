import type { JsonObject, JsonValue, Notifier, NotifierResult } from '@kaname-relay/core';

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

export function createTelegramNotifier(fetchFn: FetchLike = fetch): Notifier {
  return {
    type: 'telegram',
    async send(message, context) {
      const botToken = requiredString(context.channel.secrets.botToken, 'telegram botToken');
      const chatId = requiredString(
        context.channel.config.chatId ?? context.channel.secrets.chatId,
        'telegram chatId',
      );
      const parseMode = optionalString(context.channel.config.parseMode);
      const disableWebPagePreview =
        typeof context.channel.config.disableWebPagePreview === 'boolean'
          ? context.channel.config.disableWebPagePreview
          : undefined;

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

function resendErrorMessage(status: number, responseBody: JsonObject): string {
  const message = optionalString(responseBody.message);

  return message ? `resend send failed (${status}): ${message}` : `resend send failed (${status})`;
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
