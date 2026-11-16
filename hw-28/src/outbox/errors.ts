const TRANSIENT_PG_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '55P03', // lock_not_available
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

/**
 * True when retrying the same work later can succeed: lost connection,
 * failover, lock/serialization conflicts. Constraint and data errors are
 * permanent and retrying them only delays the DLQ.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code.startsWith('08')) return true; // connection_exception class
    if (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code)) return true;
  }
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    /Connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(
      message,
    )
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
