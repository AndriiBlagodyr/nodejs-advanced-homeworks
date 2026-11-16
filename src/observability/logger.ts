import { trace } from '@opentelemetry/api';
import pino from 'pino';
import { getContext } from './context';
import { pushLogLine } from './log-buffer';

/**
 * Mask by key name, at any depth. A path whitelist leaves a field the list
 * never named sitting in the line with its value.
 */
const SECRET_KEY = /authorization|password|passwd|secret|token|api[-_]?key|cookie/i;

export const REDACTED = '[Redacted]';

export function censorSecrets(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached) return cached;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(censorSecrets(item, seen));
    return copy;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : censorSecrets(child, seen);
  }
  return out;
}

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
    formatters: {
      log(object) {
        return censorSecrets(object) as Record<string, unknown>;
      },
    },
  },
  destination,
);

export function childLogger(layer: string) {
  return logger.child({ layer });
}
