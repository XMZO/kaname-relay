import { describe, expect, it, vi } from 'vitest';

import { createTelegramNotifier, TelegramNotifierError } from './index.js';

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
