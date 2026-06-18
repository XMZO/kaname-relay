import { describe, expect, it, vi } from 'vitest';

import {
  createResendNotifier,
  createTelegramNotifier,
  ResendNotifierError,
  TelegramNotifierError,
} from './index.js';

describe('createTelegramNotifier', () => {
  it('sends Telegram sendMessage requests and returns provider metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
          },
        }),
        { status: 200 },
      ),
    );
    const notifier = createTelegramNotifier(fetchMock);

    const result = await notifier.send(
      { text: 'hello' },
      {
        channel: {
          id: 'channel-1',
          name: 'Telegram',
          type: 'telegram',
          enabled: true,
          config: {
            chatId: '12345',
            parseMode: 'MarkdownV2',
          },
          secrets: {
            botToken: 'token',
          },
        },
        idempotencyKey: 'outbound-1',
        now: () => 1_000,
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '12345',
          text: 'hello',
          parse_mode: 'MarkdownV2',
        }),
      }),
    );
    expect(result).toEqual({
      providerMessageId: '42',
      providerResponseJson: {
        ok: true,
        result: {
          message_id: 42,
        },
      },
    });
  });

  it('marks Telegram rate limits as retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description: 'Too Many Requests',
        }),
        { status: 429 },
      ),
    );
    const notifier = createTelegramNotifier(fetchMock);

    await expect(
      notifier.send(
        { text: 'hello' },
        {
          channel: {
            id: 'channel-1',
            name: 'Telegram',
            type: 'telegram',
            enabled: true,
            config: {
              chatId: '12345',
            },
            secrets: {
              botToken: 'token',
            },
          },
          idempotencyKey: 'outbound-1',
          now: () => 1_000,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({
      retryable: true,
      statusCode: 429,
    } satisfies Partial<TelegramNotifierError>);
  });
});

describe('createResendNotifier', () => {
  it('sends Resend email requests with idempotency keys', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'email-1',
        }),
        { status: 200 },
      ),
    );
    const notifier = createResendNotifier(fetchMock);

    const result = await notifier.send(
      {
        title: 'Alert',
        text: 'hello',
        html: '<p>hello</p>',
      },
      {
        channel: {
          id: 'channel-email',
          name: 'Email',
          type: 'resend',
          enabled: true,
          config: {
            from: 'Kaname <alerts@example.com>',
            to: ['ops@example.com'],
            replyTo: 'noreply@example.com',
          },
          secrets: {
            apiKey: 're_key',
          },
        },
        idempotencyKey: 'outbound-email-1',
        now: () => 1_000,
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer re_key',
          'content-type': 'application/json',
          'idempotency-key': 'outbound-email-1',
        }),
        body: JSON.stringify({
          from: 'Kaname <alerts@example.com>',
          to: ['ops@example.com'],
          subject: 'Alert',
          text: 'hello',
          reply_to: 'noreply@example.com',
          html: '<p>hello</p>',
        }),
      }),
    );
    expect(result).toEqual({
      providerMessageId: 'email-1',
      providerResponseJson: {
        id: 'email-1',
      },
    });
  });

  it('marks Resend rate limits as retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'rate_limit_exceeded',
          message: 'Too many requests',
        }),
        { status: 429 },
      ),
    );
    const notifier = createResendNotifier(fetchMock);

    await expect(
      notifier.send(
        { text: 'hello' },
        {
          channel: {
            id: 'channel-email',
            name: 'Email',
            type: 'resend',
            enabled: true,
            config: {
              from: 'alerts@example.com',
              to: 'ops@example.com',
            },
            secrets: {
              apiKey: 're_key',
            },
          },
          idempotencyKey: 'outbound-email-1',
          now: () => 1_000,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({
      retryable: true,
      statusCode: 429,
      providerCode: 'rate_limit_exceeded',
    } satisfies Partial<ResendNotifierError>);
  });
});
