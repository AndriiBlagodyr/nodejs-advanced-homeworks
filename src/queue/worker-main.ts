import { Worker } from 'bullmq';
import { createPool } from '../outbox/pg';
import { connectQueueProducerRedis, connectQueueWorkerRedis } from '../redis/clients';
import {
  createReceiptsProcessor,
  createReceiptsQueue,
  RECEIPTS_QUEUE,
  upsertFilesOrphanScheduler,
  upsertOutboxPurgeScheduler,
} from './receipts.queue';
import { storageConfigured } from '../storage/config';
import { storageFromEnv } from '../storage/storage';

async function main(): Promise<void> {
  const pool = createPool();
  const producerConn = await connectQueueProducerRedis();
  const workerConn = await connectQueueWorkerRedis();

  const queue = createReceiptsQueue(producerConn);
  await upsertOutboxPurgeScheduler(queue);
  const storage = storageConfigured() ? storageFromEnv() : undefined;
  if (storage) await upsertFilesOrphanScheduler(queue);

  const worker = new Worker(RECEIPTS_QUEUE, createReceiptsProcessor({ pool, storage }), {
    connection: workerConn,
    concurrency: 5,
  });
  worker.on('failed', (job, err) => {
    console.warn(`job ${job?.name}#${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });
  console.log(`worker started on queue ${RECEIPTS_QUEUE}`);

  const shutdown = async () => {
    await worker.close();
    await queue.close();
    await Promise.all([producerConn.quit(), workerConn.quit(), pool.end()]);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
