import type { Channel, ChannelModel } from 'amqplib';
import {
  EXCHANGE_DLX,
  EXCHANGE_EVENTS,
  EXCHANGE_UNROUTABLE,
  QUEUE_ORDER_PLACED,
  QUEUE_ORDER_PLACED_DLQ,
  QUEUE_UNROUTABLE,
  ROUTING_ORDER_PLACED,
} from './constants';

const quorum = { 'x-queue-type': 'quorum' } as const;

/**
 * Consumer/bootstrap owns topology. The producer only publishes to shop.events.
 */
export async function assertTopology(ch: Channel): Promise<void> {
  await ch.assertExchange(EXCHANGE_UNROUTABLE, 'fanout', { durable: true });
  await ch.assertQueue(QUEUE_UNROUTABLE, {
    durable: true,
    arguments: { ...quorum },
  });
  await ch.bindQueue(QUEUE_UNROUTABLE, EXCHANGE_UNROUTABLE, '');

  await ch.assertExchange(EXCHANGE_EVENTS, 'topic', {
    durable: true,
    arguments: { 'alternate-exchange': EXCHANGE_UNROUTABLE },
  });

  await ch.assertExchange(EXCHANGE_DLX, 'fanout', { durable: true });
  await ch.assertQueue(QUEUE_ORDER_PLACED_DLQ, {
    durable: true,
    arguments: { ...quorum },
  });
  await ch.bindQueue(QUEUE_ORDER_PLACED_DLQ, EXCHANGE_DLX, '');

  await ch.assertQueue(QUEUE_ORDER_PLACED, {
    durable: true,
    arguments: {
      ...quorum,
      'x-dead-letter-exchange': EXCHANGE_DLX,
    },
  });
  await ch.bindQueue(QUEUE_ORDER_PLACED, EXCHANGE_EVENTS, ROUTING_ORDER_PLACED);
}

export async function resetWorkQueues(ch: Channel): Promise<void> {
  for (const q of [QUEUE_ORDER_PLACED, QUEUE_ORDER_PLACED_DLQ, QUEUE_UNROUTABLE]) {
    try {
      await ch.deleteQueue(q, { ifUnused: false, ifEmpty: false });
    } catch {
      /* queue may not exist yet */
    }
  }
}

export async function purgeWorkAndDlq(ch: Channel): Promise<void> {
  await ch.purgeQueue(QUEUE_ORDER_PLACED);
  await ch.purgeQueue(QUEUE_ORDER_PLACED_DLQ);
}

export async function queueDepth(ch: Channel, queue: string): Promise<number> {
  const info = await ch.checkQueue(queue);
  return info.messageCount;
}

export async function closeBroker(conn: ChannelModel, ch: Channel): Promise<void> {
  await ch.close();
  await conn.close();
}
