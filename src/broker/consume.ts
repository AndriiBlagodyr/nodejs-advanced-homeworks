import type { Channel, ConsumeMessage } from 'amqplib';
import { Client } from 'pg';
import { BROKER_PREFETCH, QUEUE_ORDER_PLACED } from './constants';
import { applyOrderPlacedEffect } from './effect';
import { QUEUE_ORDER_PLACED_DLQ } from './constants';
import { queueDepth } from './topology';

export type ConsumeStats = {
  delivered: number;
  effect: number;
  acked: number;
  skipped: number;
  rejected: number;
};

export async function consumeUntil(
  ch: Channel,
  opts: {
    db: Client;
    stop: (stats: ConsumeStats) => boolean;
    onPoison?: (msg: ConsumeMessage) => 'reject' | 'nack-requeue' | 'ack';
    afterEffect?: (
      msg: ConsumeMessage,
      applied: boolean,
      redelivered: boolean,
    ) => 'ack' | 'nack-requeue';
    timeoutMs?: number;
  },
): Promise<ConsumeStats> {
  const stats: ConsumeStats = {
    delivered: 0,
    effect: 0,
    acked: 0,
    skipped: 0,
    rejected: 0,
  };
  await ch.prefetch(BROKER_PREFETCH);

  const { consumerTag } = await ch.consume(
    QUEUE_ORDER_PLACED,
    (msg) => {
      if (!msg) return;
      void handle(ch, opts, stats, msg);
    },
    { noAck: false },
  );

  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  while (!opts.stop(stats)) {
    if (Date.now() > deadline) {
      await ch.cancel(consumerTag);
      throw new Error('consumer timeout');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  await ch.cancel(consumerTag);
  return stats;
}

async function handle(
  ch: Channel,
  opts: Parameters<typeof consumeUntil>[1],
  stats: ConsumeStats,
  msg: ConsumeMessage,
): Promise<void> {
  stats.delivered += 1;
  const eventId = parseEventId(msg);
  if (!eventId) {
    const action = opts.onPoison?.(msg) ?? 'reject';
    if (action === 'ack') {
      ch.ack(msg);
      stats.acked += 1;
    } else if (action === 'nack-requeue') {
      ch.nack(msg, false, true);
    } else {
      ch.reject(msg, false);
      stats.rejected += 1;
    }
    return;
  }

  const applied = await applyOrderPlacedEffect(opts.db, eventId);
  if (applied) stats.effect += 1;
  else stats.skipped += 1;
  const ackAction =
    opts.afterEffect?.(msg, applied, Boolean(msg.fields.redelivered)) ?? 'ack';
  if (ackAction === 'nack-requeue') {
    ch.nack(msg, false, true);
  } else {
    ch.ack(msg);
    stats.acked += 1;
  }
}

export function parseEventId(msg: ConsumeMessage): string | null {
  try {
    const body = JSON.parse(msg.content.toString()) as {
      eventId?: string;
      poison?: boolean;
    };
    if (body.poison) return null;
    if (typeof body.eventId === 'string' && body.eventId.length > 0) {
      return body.eventId;
    }
    return null;
  } catch {
    return null;
  }
}

export async function depths(ch: Channel): Promise<{ work: number; dlq: number }> {
  return {
    work: await queueDepth(ch, QUEUE_ORDER_PLACED),
    dlq: await queueDepth(ch, QUEUE_ORDER_PLACED_DLQ),
  };
}

export async function readDlqReason(ch: Channel): Promise<string | null> {
  const msg = await ch.get(QUEUE_ORDER_PLACED_DLQ, { noAck: false });
  if (!msg) return null;
  const headers = msg.properties.headers ?? {};
  const first = headers['x-first-death-reason'];
  const deaths = headers['x-death'];
  let reason: string | null = null;
  if (typeof first === 'string') reason = first;
  else if (Array.isArray(deaths) && deaths[0] && typeof deaths[0] === 'object') {
    const r = (deaths[0] as { reason?: string }).reason;
    if (typeof r === 'string') reason = r;
  }
  ch.ack(msg);
  return reason;
}
