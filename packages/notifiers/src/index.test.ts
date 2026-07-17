import { describe, expect, it, vi } from 'vitest';

import {
  createResendNotifier,
  createTelegramNotifier,
  createWebhookNotifier,
  ResendNotifierError,
  TelegramNotifierError,
  WebhookNotifierError,
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

  it('applies Telegram formatting and inline buttons from notification metadata', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }), { status: 200 }),
      );
    const notifier = createTelegramNotifier(fetchMock);

    await notifier.send(
      {
        text: '<b>Node offline</b>',
        metadata: {
          telegram: {
            parseMode: 'HTML',
            disableWebPagePreview: true,
            inlineKeyboard: [
              [
                { text: 'Panel', url: 'https://status.example.com' },
                { text: 'Empty URL', url: '' },
              ],
            ],
          },
        },
      },
      {
        channel: {
          id: 'channel-1',
          name: 'Telegram',
          type: 'telegram',
          enabled: true,
          config: { chatId: '12345' },
          secrets: { botToken: 'token' },
        },
        idempotencyKey: 'outbound-2',
        now: () => 1_000,
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken/sendMessage',
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: '12345',
          text: '<b>Node offline</b>',
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{ text: 'Panel', url: 'https://status.example.com' }]],
          },
        }),
      }),
    );
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

describe('createWebhookNotifier', () => {
  it('sends generic webhook requests with configured headers and idempotency keys', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'webhook-message-1',
          ok: true,
        }),
        { status: 202 },
      ),
    );
    const notifier = createWebhookNotifier(fetchMock);

    const result = await notifier.send(
      {
        title: 'Alert',
        text: 'hello',
        tags: ['ops'],
        metadata: {
          source: 'test',
        },
        render: {
          renderer: 'html-image',
          html: '<main>hello</main>',
          format: 'png',
        },
      },
      {
        channel: {
          id: 'channel-webhook',
          name: 'Webhook',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'https://example.com/hooks/notify',
            headers: {
              'x-route': 'ops',
            },
            idempotencyHeader: 'Idempotency-Key',
          },
          secrets: {
            headers: {
              authorization: 'Bearer token',
            },
          },
        },
        idempotencyKey: 'outbound-webhook-1',
        now: () => 1_000,
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/hooks/notify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-route': 'ops',
          authorization: 'Bearer token',
          'idempotency-key': 'outbound-webhook-1',
        }),
        body: JSON.stringify({
          text: 'hello',
          title: 'Alert',
          tags: ['ops'],
          metadata: {
            source: 'test',
          },
          render: {
            renderer: 'html-image',
            html: '<main>hello</main>',
            format: 'png',
          },
        }),
      }),
    );
    expect(result).toEqual({
      providerMessageId: 'webhook-message-1',
      providerResponseJson: {
        id: 'webhook-message-1',
        ok: true,
      },
    });
  });

  it('marks generic webhook rate limits as retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Too many requests',
        }),
        { status: 429 },
      ),
    );
    const notifier = createWebhookNotifier(fetchMock);

    await expect(
      notifier.send(
        { text: 'hello' },
        {
          channel: {
            id: 'channel-webhook',
            name: 'Webhook',
            type: 'webhook',
            enabled: true,
            config: {
              url: 'https://example.com/hooks/notify',
            },
            secrets: {},
          },
          idempotencyKey: 'outbound-webhook-1',
          now: () => 1_000,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({
      retryable: true,
      statusCode: 429,
    } satisfies Partial<WebhookNotifierError>);
  });
});
