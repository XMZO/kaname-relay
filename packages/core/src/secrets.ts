import type { JsonObject, JsonValue } from './types.js';

export interface SecretCodec {
  encrypt(secret: JsonObject): Promise<string>;
  decrypt(secretJsonEnc: string | null): Promise<JsonObject>;
}

export interface VerifyWebhookSignatureInput {
  rawBody: string;
  headers: Headers;
  config: JsonObject;
  secrets: JsonObject;
}

const SECRET_PREFIX = 'v1';
const encoder = new TextEncoder();

export function createAesGcmSecretCodec(appSecret: string): SecretCodec {
  if (appSecret.length < 16) {
    throw new Error('APP_SECRET must be at least 16 characters');
  }

  return {
    async encrypt(secret) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveAesKey(appSecret);
      const plaintext = encoder.encode(JSON.stringify(secret));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
          },
          key,
          plaintext,
        ),
      );

      return `${SECRET_PREFIX}.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
    },
    async decrypt(secretJsonEnc) {
      if (!secretJsonEnc) {
        return {};
      }

      if (!secretJsonEnc.startsWith(`${SECRET_PREFIX}.`)) {
        return parseSecretJson(secretJsonEnc);
      }

      const [, ivEncoded, ciphertextEncoded] = secretJsonEnc.split('.');

      if (!ivEncoded || !ciphertextEncoded) {
        throw new Error('invalid encrypted secret bundle');
      }

      const key = await deriveAesKey(appSecret);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64UrlToBytes(ivEncoded),
        },
        key,
        base64UrlToBytes(ciphertextEncoded),
      );

      return parseSecretJson(new TextDecoder().decode(plaintext));
    },
  };
}

export async function verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<boolean> {
  const secret = stringOrUndefined(input.secrets.webhookSecret);

  if (secret === undefined) {
    return true;
  }

  const headerName = stringOrUndefined(input.config.signatureHeader) ?? 'x-kaname-signature';
  const signature = input.headers.get(headerName);

  if (!signature) {
    return false;
  }

  const expected = await hmacSha256Hex(secret, input.rawBody);
  const normalized = signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;

  return timingSafeHexEqual(normalized, expected);
}

export function parseSecretJson(secretJsonEnc: string): JsonObject {
  const parsed = JSON.parse(secretJsonEnc) as JsonValue;

  if (!isJsonObject(parsed)) {
    throw new Error('secret bundle must be a JSON object');
  }

  return parsed;
}

async function deriveAesKey(appSecret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(appSecret));

  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
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

  return bytesToHex(signature);
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);

  if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function stringOrUndefined(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
