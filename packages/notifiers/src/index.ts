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

function telegramErrorMessage(status: number, responseBody: JsonObject): string {
  const description = optionalString(responseBody.description);

  return description
    ? `telegram send failed (${status}): ${description}`
    : `telegram send failed (${status})`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function providerMessageId(responseBody: JsonObject): string | undefined {
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

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
