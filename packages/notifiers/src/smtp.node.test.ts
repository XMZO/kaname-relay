import { describe, expect, it, vi } from 'vitest';

import { createSmtpNotifier, SmtpNotifierError, type SmtpTransportFactory } from './smtp.node.js';

describe('createSmtpNotifier', () => {
  it('sends mail through the injected SMTP transport', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: 'smtp-1',
      response: '250 queued',
      accepted: ['ops@example.com'],
    });
    const factory = vi.fn<SmtpTransportFactory>().mockReturnValue({
      sendMail,
    });
    const notifier = createSmtpNotifier(factory);

    const result = await notifier.send(
      {
        title: 'Alert',
        text: 'hello',
        html: '<p>hello</p>',
      },
      {
        channel: {
          id: 'channel-smtp',
          name: 'SMTP',
          type: 'smtp',
          enabled: true,
          config: {
            host: 'smtp.example.com',
            port: 465,
            secure: true,
            from: 'alerts@example.com',
            to: ['ops@example.com'],
          },
          secrets: {
            user: 'smtp-user',
            pass: 'smtp-pass',
          },
        },
        idempotencyKey: 'outbound-smtp-1',
        now: () => 1_000,
        signal: new AbortController().signal,
      },
    );

    expect(factory).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: {
        user: 'smtp-user',
        pass: 'smtp-pass',
      },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'alerts@example.com',
      to: ['ops@example.com'],
      subject: 'Alert',
      text: 'hello',
      html: '<p>hello</p>',
    });
    expect(result).toEqual({
      providerMessageId: 'smtp-1',
      providerResponseJson: {
        messageId: 'smtp-1',
        response: '250 queued',
        accepted: ['ops@example.com'],
      },
    });
  });

  it('marks 5xx SMTP rejections as non-retryable', async () => {
    const sendMail = vi.fn().mockRejectedValue(
      Object.assign(new Error('mailbox unavailable'), {
        code: 'EENVELOPE',
        responseCode: 550,
      }),
    );
    const notifier = createSmtpNotifier(() => ({
      sendMail,
    }));

    await expect(
      notifier.send(
        { text: 'hello' },
        {
          channel: {
            id: 'channel-smtp',
            name: 'SMTP',
            type: 'smtp',
            enabled: true,
            config: {
              host: 'smtp.example.com',
              from: 'alerts@example.com',
              to: 'ops@example.com',
            },
            secrets: {},
          },
          idempotencyKey: 'outbound-smtp-1',
          now: () => 1_000,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({
      retryable: false,
      statusCode: 550,
      providerCode: 'EENVELOPE',
    } satisfies Partial<SmtpNotifierError>);
  });

  it('supports Komari-style LOGIN auth and STARTTLS for Outlook SMTP', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: 'smtp-outlook-1',
    });
    const factory = vi.fn<SmtpTransportFactory>().mockReturnValue({
      sendMail,
    });
    const notifier = createSmtpNotifier(factory);

    await notifier.send(
      { text: 'hello' },
      {
        channel: {
          id: 'channel-smtp',
          name: 'Outlook SMTP',
          type: 'smtp',
          enabled: true,
          config: {
            host: 'smtp.office365.com',
            port: 587,
            use_ssl: true,
            use_login_auth: true,
            from: 'alerts@example.com',
            to: 'ops@example.com',
          },
          secrets: {
            user: 'alerts@example.com',
            pass: 'app-password',
          },
        },
        idempotencyKey: 'outbound-smtp-1',
        now: () => 1_000,
        signal: new AbortController().signal,
      },
    );

    expect(factory).toHaveBeenCalledWith({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      requireTLS: true,
      authMethod: 'LOGIN',
      auth: {
        user: 'alerts@example.com',
        pass: 'app-password',
      },
    });
  });
});
