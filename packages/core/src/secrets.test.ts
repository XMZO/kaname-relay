import { describe, expect, it } from 'vitest';

import { createAesGcmSecretCodec, verifyWebhookSignature } from './secrets.js';

describe('secret codec', () => {
  it('encrypts and decrypts JSON secret bundles', async () => {
    const codec = createAesGcmSecretCodec('0123456789abcdef');
    const encrypted = await codec.encrypt({
      botToken: 'secret-token',
    });

    expect(encrypted).toMatch(/^v1\./);
    await expect(codec.decrypt(encrypted)).resolves.toEqual({
      botToken: 'secret-token',
    });
  });

  it('keeps plaintext JSON fallback readable for migration', async () => {
    const codec = createAesGcmSecretCodec('0123456789abcdef');

    await expect(codec.decrypt('{"botToken":"plain"}')).resolves.toEqual({
      botToken: 'plain',
    });
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts valid sha256 HMAC signatures', async () => {
    const rawBody = '{"ok":true}';
    const signature = await hmacSha256Hex('webhook-secret', rawBody);

    await expect(
      verifyWebhookSignature({
        rawBody,
        headers: new Headers({
          'x-kaname-signature': `sha256=${signature}`,
        }),
        config: {},
        secrets: {
          webhookSecret: 'webhook-secret',
        },
      }),
    ).resolves.toBe(true);
  });

  it('rejects invalid signatures and skips verification when no secret is configured', async () => {
    await expect(
      verifyWebhookSignature({
        rawBody: '{"ok":true}',
        headers: new Headers({
          'x-kaname-signature': 'sha256=00',
        }),
        config: {},
        secrets: {
          webhookSecret: 'webhook-secret',
        },
      }),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({
        rawBody: '{"ok":true}',
        headers: new Headers(),
        config: {},
        secrets: {},
      }),
    ).resolves.toBe(true);
  });
});

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));

  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
