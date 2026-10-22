import type { Queue } from 'bullmq';
import { connectBroker } from '../broker/connection';
import { createReceiptsQueue, enqueueReceipt } from '../queue/receipts.queue';
import { connectQueueProducerRedis } from '../redis/clients';
import { type ConsumerOptions, startOrderPlacedConsumer } from './consumer';
import { createPool } from './pg';
import { assertTopology } from '../broker/topology';

async function main(): Promise<void> {
  const pool = createPool();
  const conn = await connectBroker();
  const ch = await conn.createChannel();
  await assertTopology(ch);

  // The receipt is slow work that does not belong to the consumer's DB
  // transaction: it goes to BullMQ, deduplicated by orderId.
  let queue: Queue | undefined;
  const opts: ConsumerOptions = {};
  if (process.env.REDIS_QUEUE_URL) {
    queue = createReceiptsQueue(await connectQueueProducerRedis());
    const q = queue;
    opts.afterEffect = async (event) => {
      await enqueueReceipt(q, {
        orderId: event.data.orderId,
        userId: event.data.userId,
        totalCents: event.data.totalCents,
      });
    };
  }

  const consumer = await startOrderPlacedConsumer(ch, pool, undefined, opts);
  console.log(`order.placed consumer started${queue ? ' (receipts → BullMQ)' : ''}`);

  const shutdown = async () => {
    await consumer.stop();
    await ch.close();
    await conn.close();
    await queue?.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
