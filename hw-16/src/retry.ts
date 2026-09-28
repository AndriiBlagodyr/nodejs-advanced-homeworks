const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

export type PgLikeError = {
  code?: string;
  driverError?: { code?: string };
};

export function getPgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const err = error as PgLikeError;
  return err.code ?? err.driverError?.code;
}

export function isRetryableSerializationError(error: unknown): boolean {
  const code = getPgErrorCode(error);
  return code !== undefined && RETRYABLE_PG_CODES.has(code);
}

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (info: {
    attempt: number;
    code: string;
    error: unknown;
  }) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-runs the whole transaction callback on serialization / deadlock failures.
 * Only Postgres codes 40001 and 40P01 are retried.
 */
export async function withSerializationRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 20;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const code = getPgErrorCode(error);
      if (
        !code ||
        !RETRYABLE_PG_CODES.has(code) ||
        attempt >= maxAttempts
      ) {
        throw error;
      }

      options.onRetry?.({ attempt, code, error });
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await sleep(baseDelayMs * attempt + jitter);
    }
  }
}
