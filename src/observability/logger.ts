import { trace } from '@opentelemetry/api';
import pino from 'pino';
import { getContext } from './context';
import { pushLogLine } from './log-buffer';

/**
 * Paths redact knows about. A nested field that is not listed stays in the
 * line: pino does not guess. Authorization and the login password are listed;
 * a random nested token would not be.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'headers.authorization',
  'authorization',
  'password',
  'req.body.password',
  'body.password',
  'refresh_token',
  'req.body.refresh_token',
  'body.refresh_token',
];

const destination = {
  write(chunk: string): void {
    pushLogLine(chunk);
    process.stdout.write(chunk);
  },
};

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    // The correlator is the active span's trace id, not a uuid we minted.
    mixin() {
      const span = trace.getActiveSpan();
      const ctx = getContext();
      return {
        trace_id: span?.spanContext().traceId,
        span_id: span?.spanContext().spanId,
        userId: ctx?.userId,
        tenant: ctx?.tenant,
        idempotencyKey: ctx?.idempotencyKey,
      };
    },
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  },
  destination,
);

export function childLogger(layer: string) {
  return logger.child({ layer });
}
