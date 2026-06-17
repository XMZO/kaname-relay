import type { BackoffConfig } from './types.js';

export function computeBackoffMs(
  attempts: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempts - 1);
  const baseDelay = Math.min(
    config.initialDelayMs * config.multiplier ** exponent,
    config.maxDelayMs,
  );
  const jitterRatio = config.jitterRatio ?? 0;

  if (jitterRatio <= 0) {
    return Math.round(baseDelay);
  }

  const spread = baseDelay * jitterRatio;
  const offset = (random() * 2 - 1) * spread;

  return Math.max(0, Math.round(baseDelay + offset));
}

export function buildBackoffDelayMap(
  config: BackoffConfig,
  random: () => number = Math.random,
): Record<number, number> {
  const delays: Record<number, number> = {};

  for (let attempts = 1; attempts <= 9; attempts += 1) {
    delays[attempts] = computeBackoffMs(attempts, config, random);
  }

  return delays;
}
