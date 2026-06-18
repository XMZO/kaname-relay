import nodemailer from 'nodemailer';

import type { JsonObject, JsonValue, Notifier, NotifierResult } from '@kaname-relay/core';

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth?: {
    user: string;
    pass: string;
  };
}

export interface SmtpMailOptions {
  from: string;
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

export interface SmtpSentInfo {
  messageId?: string;
  response?: string;
  accepted?: string[];
  rejected?: string[];
}

export interface SmtpTransportLike {
  sendMail(options: SmtpMailOptions): Promise<SmtpSentInfo>;
}

export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransportLike;

export class SmtpNotifierError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'SmtpNotifierError';
  }
}

export function createSmtpNotifier(
  transportFactory: SmtpTransportFactory = defaultTransportFactory,
): Notifier {
  return {
    type: 'smtp',
    async send(message, context) {
      const host = requiredString(context.channel.config.host, 'smtp host');
      const port = optionalNumber(context.channel.config.port) ?? 587;
      const secure = optionalBoolean(context.channel.config.secure) ?? port === 465;
      const from = requiredString(context.channel.config.from, 'smtp from');
      const to = requiredStringOrStringArray(context.channel.config.to, 'smtp to');
      const subject =
        message.title ??
        optionalString(context.channel.config.subject) ??
        'Kaname Relay notification';
      const user = optionalString(context.channel.secrets.user);
      const pass = optionalString(context.channel.secrets.pass);
      const transportOptions: SmtpTransportOptions = {
        host,
        port,
        secure,
      };
      const mailOptions: SmtpMailOptions = {
        from,
        to,
        subject,
        text: message.text,
      };

      if (user !== undefined || pass !== undefined) {
        if (user === undefined || pass === undefined) {
          throw new SmtpNotifierError('smtp user and pass must be provided together', false);
        }

        transportOptions.auth = {
          user,
          pass,
        };
      }

      if (message.html !== undefined) {
        mailOptions.html = message.html;
      }

      try {
        const info = await transportFactory(transportOptions).sendMail(mailOptions);
        const result: NotifierResult = {
          providerResponseJson: smtpInfoToJson(info),
        };

        if (info.messageId !== undefined) {
          result.providerMessageId = info.messageId;
        }

        return result;
      } catch (error) {
        throw smtpError(error);
      }
    },
  };
}

function defaultTransportFactory(options: SmtpTransportOptions): SmtpTransportLike {
  return nodemailer.createTransport(options) as unknown as SmtpTransportLike;
}

function smtpInfoToJson(info: SmtpSentInfo): JsonObject {
  const json: JsonObject = {};

  if (info.messageId !== undefined) {
    json.messageId = info.messageId;
  }

  if (info.response !== undefined) {
    json.response = info.response;
  }

  if (info.accepted !== undefined) {
    json.accepted = info.accepted;
  }

  if (info.rejected !== undefined) {
    json.rejected = info.rejected;
  }

  return json;
}

function smtpError(error: unknown): SmtpNotifierError {
  if (error instanceof SmtpNotifierError) {
    return error;
  }

  const details = isObject(error) ? error : {};
  const responseCode = typeof details.responseCode === 'number' ? details.responseCode : undefined;
  const code = typeof details.code === 'string' ? details.code : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof details.message === 'string'
        ? details.message
        : 'smtp send failed';

  return new SmtpNotifierError(
    `smtp send failed: ${message}`,
    responseCode === undefined ? true : responseCode >= 400 && responseCode < 500,
    responseCode,
    code,
  );
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SmtpNotifierError(`missing ${label}`, false);
  }

  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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

  throw new SmtpNotifierError(`missing ${label}`, false);
}

function isObject(value: unknown): value is {
  code?: unknown;
  message?: unknown;
  responseCode?: unknown;
} {
  return typeof value === 'object' && value !== null;
}
