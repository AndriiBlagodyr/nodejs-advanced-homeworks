import type { Channel, ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import { BROKER_PREFETCH, QUEUE_ORDER_PLACED } from '../broker/constants';
import { type OrderPlacedEvent, parseOrderPlacedEvent } from './order-placed.event';

export const CONSUMER_NAME = 'order-confirmations';

export type ConsumerStats = {
  deliveries: number;
  applied: number;
  skipped: number;
  rejected: number;
  failed: number;
};

export function emptyStats(): ConsumerStats {
  return { deliveries: 0, applied: 0, skipped: 0, rejected: 0, failed: 0 };
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

export async function startOrderPlacedConsumer(
  ch: Channel,
  pool: Pool,
  stats: ConsumerStats = emptyStats(),
): Promise<{ stats: ConsumerStats; stop: () => Promise<void> }> {
  await ch.prefetch(BROKER_PREFETCH);
  const { consumerTag } = await ch.consume(
    QUEUE_ORDER_PLACED,
    (msg) => {
      if (!msg) return;
      void handle(ch, pool, stats, msg);
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
): Promise<void> {
  stats.deliveries += 1;
  const event = parseOrderPlacedEvent(msg.content);
  if (!event) {
    stats.rejected += 1;
    safely(() => ch.reject(msg, false));
    return;
  }
  try {
    const applied = await applyOrderPlaced(pool, event);
    if (applied) stats.applied += 1;
    else stats.skipped += 1;
    ch.ack(msg);
  } catch {
    stats.failed += 1;
    safely(() => ch.nack(msg, false, false));
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* channel already closed */
  }
}
