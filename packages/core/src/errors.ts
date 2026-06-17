import type { NotifierError } from './types.js';

export interface ClassifiedFailure {
  message: string;
  retryable: boolean;
}

export function classifyNotifierError(error: unknown): ClassifiedFailure {
  const message = truncateErrorMessage(errorMessage(error));

  if (isNotifierError(error)) {
    return {
      message,
      retryable: error.retryable,
    };
  }

  const statusCode = statusCodeOf(error);

  if (statusCode !== undefined) {
    return {
      message,
      retryable: isRetryableStatus(statusCode),
    };
  }

  return {
    message,
    retryable: true,
  };
}

function isNotifierError(error: unknown): error is NotifierError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    typeof (error as { retryable: unknown }).retryable === 'boolean'
  );
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }

  const statusCode = (error as { statusCode: unknown }).statusCode;

  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isRetryableStatus(statusCode: number): boolean {
  if (statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429) {
    return true;
  }

  if (statusCode >= 500) {
    return true;
  }

  if (statusCode >= 400 && statusCode < 500) {
    return false;
  }

  return true;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'unknown notifier error';
}

function truncateErrorMessage(message: string): string {
  const maxLength = 2_000;

  return message.length > maxLength ? message.slice(0, maxLength) : message;
}
