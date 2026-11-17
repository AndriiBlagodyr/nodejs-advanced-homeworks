import type { Channel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import { BROKER_PREFETCH, QUEUE_ORDER_PLACED } from '../broker/constants';
import { isTransientDbError } from './errors';
import { type OrderPlacedEvent, parseOrderPlacedEvent } from './order-placed.event';

export const CONSUMER_NAME = 'order-confirmations';
/** In-process attempts per delivery for transient DB errors (backoff 100/200 ms). */
export const CONSUMER_LOCAL_ATTEMPTS = 3;
export const CONSUMER_RETRY_BASE_MS = 100;
/** After this many broker redeliveries a still-failing message goes to the DLQ. */
export const CONSUMER_MAX_REDELIVERIES = 5;

export type ConsumerStats = {
  deliveries: number;
  applied: number;
  skipped: number;
  rejected: number;
  requeued: number;
  failed: number;
};

export function emptyStats(): ConsumerStats {
  return { deliveries: 0, applied: 0, skipped: 0, rejected: 0, requeued: 0, failed: 0 };
}

/**
 * Level 2 (inbox) + level 1 (natural key) in ONE transaction on ONE client:
 * the processed_messages mark and the effect commit or vanish together.
 * Returns false when this message was already processed by this consumer.
 */
export async function applyOrderPlaced(pool: Pool, event: OrderPlacedEvent): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mark = await client.query(
      `INSERT INTO processed_messages (message_id, consumer)
       VALUES ($1, $2)
       ON CONFLICT (message_id, consumer) DO NOTHING`,
      [event.eventId, CONSUMER_NAME],
    );
    if (mark.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO order_confirmations (order_id, event_id, user_id, total_cents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO NOTHING`,
      [event.data.orderId, event.eventId, event.data.userId, event.data.totalCents],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type ConsumerOptions = {
  /**
   * Runs after the effect committed (or was found already applied) and before
   * ack, on every delivery. Must be idempotent itself, e.g. a BullMQ add with
   * a stable jobId. A failure requeues the message like a transient DB error.
   */
  afterEffect?: (event: OrderPlacedEvent) => Promise<void>;
};

class AfterEffectError extends Error {}

export async function startOrderPlacedConsumer(
  ch: Channel,
  pool: Pool,
  stats: ConsumerStats = emptyStats(),
  opts: ConsumerOptions = {},
): Promise<{ stats: ConsumerStats; stop: () => Promise<void> }> {
  await ch.prefetch(BROKER_PREFETCH);
  const { consumerTag } = await ch.consume(
    QUEUE_ORDER_PLACED,
    (msg) => {
      if (!msg) return;
      void handle(ch, pool, stats, msg, opts);
    },
    { noAck: false },
  );
  return {
    stats,
    stop: async () => {
      await ch.cancel(consumerTag);
    },
  };
}

async function handle(
  ch: Channel,
  pool: Pool,
  stats: ConsumerStats,
  msg: ConsumeMessage,
  opts: ConsumerOptions,
): Promise<void> {
  stats.deliveries += 1;
  const event = parseOrderPlacedEvent(msg.content);
  if (!event) {
    stats.rejected += 1;
    safely(() => ch.reject(msg, false));
    return;
  }
  try {
    const applied = await withLocalRetry(() => applyOrderPlaced(pool, event));
    if (opts.afterEffect) {
      await opts.afterEffect(event).catch((err: unknown) => {
        throw new AfterEffectError((err as Error)?.message ?? String(err));
      });
    }
    if (applied) stats.applied += 1;
    else stats.skipped += 1;
    ch.ack(msg);
  } catch (err) {
    const transient = isTransientDbError(err) || err instanceof AfterEffectError;
    if (transient && deliveryCount(msg) < CONSUMER_MAX_REDELIVERIES) {
      // Back to the queue: x-delivery-count grows on every requeue (quorum queue).
      stats.requeued += 1;
      safely(() => ch.reject(msg, true));
      return;
    }
    stats.failed += 1;
    safely(() => ch.nack(msg, false, false));
  }
}

async function withLocalRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= CONSUMER_LOCAL_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, CONSUMER_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
}

function deliveryCount(msg: ConsumeMessage): number {
  const raw = msg.properties.headers?.['x-delivery-count'];
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n)) return n;
  return msg.fields.redelivered ? 1 : 0;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* channel already closed */
  }
}
