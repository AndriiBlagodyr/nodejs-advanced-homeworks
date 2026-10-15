import { type Job, Worker } from 'bullmq';
import { createPool } from '../outbox/pg';
import {
  createReceiptsProcessor,
  createReceiptsQueue,
  enqueueReceipt,
  JOB_OUTBOX_PURGE,
  JOB_SEND_RECEIPT,
  upsertOutboxPurgeScheduler,
} from '../queue/receipts.queue';
import { configGet, connectQueueProducerRedis, connectQueueWorkerRedis } from '../redis/clients';
import { fail, report, sleep, waitFor } from './demo-kit';

/** Same code as the real queue, isolated name so the demo can wipe it. */
const DEMO_QUEUE = 'receipts-demo';
const FAIL_TIMES = 2;
const SCHEDULER_EVERY_MS = 500;
const OBSERVE_MS = 3000;

async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  const producerConn = await connectQueueProducerRedis();
  const workerConn = await connectQueueWorkerRedis();
  const pool = createPool();
  const queue = createReceiptsQueue(producerConn, DEMO_QUEUE);
  let worker: Worker | undefined;
  try {
    const policy = await configGet(producerConn, 'maxmemory-policy');
    await queue.obliterate({ force: true });

    // Dedup: two adds with one jobId → one job.
    const data = { orderId: 'demo-1', userId: '9001', totalCents: 1500, failTimes: FAIL_TIMES };
    const fast = { backoff: { type: 'exponential', delay: 100, jitter: 0.5 } };
    const first = await enqueueReceipt(queue, data, fast);
    const second = await enqueueReceipt(queue, data, fast);
    const added = 2;
    const counts = await queue.getJobCounts('waiting', 'delayed', 'prioritized', 'active');
    const queued = Object.values(counts).reduce((a, b) => a + b, 0);
    const sameJob = first.id === second.id ? 1 : 0;

    // Scheduler: upserted twice, still one.
    await upsertOutboxPurgeScheduler(queue, SCHEDULER_EVERY_MS);
    await upsertOutboxPurgeScheduler(queue, SCHEDULER_EVERY_MS);
    const schedulers = await queue.getJobSchedulersCount();

    let attempts = 0;
    let completed = 0;
    let scheduledRuns = 0;
    const processJob = createReceiptsProcessor({ pool });
    worker = new Worker(
      DEMO_QUEUE,
      async (job: Job) => {
        if (job.name === JOB_SEND_RECEIPT) attempts += 1;
        return processJob(job);
      },
      { connection: workerConn, concurrency: 2 },
    );
    worker.on('completed', (job) => {
      if (job.name === JOB_SEND_RECEIPT) completed += 1;
      if (job.name === JOB_OUTBOX_PURGE) scheduledRuns += 1;
    });

    const started = Date.now();
    await waitFor(() => completed >= 1, 15_000);
    const remaining = OBSERVE_MS - (Date.now() - started);
    if (remaining > 0) await sleep(remaining);

    // Completed job is kept (removeOnComplete by age), so a late duplicate is still deduped.
    const attemptsBefore = attempts;
    const late = await enqueueReceipt(queue, data, fast);
    await sleep(300);
    const lateState = await (await queue.getJob(late.id!))?.getState();
    const readdDeduped =
      late.id === first.id && lateState === 'completed' && attempts === attemptsBefore ? 1 : 0;

    await queue.removeJobScheduler('outbox-purge');
    const noeviction = policy === 'noeviction' ? 1 : 0;

    return {
      lines: {
        'queue-noeviction': noeviction,
        attempts,
        'fail-times': FAIL_TIMES,
        completed,
        added,
        queued,
        'same-job-id': sameJob,
        'readd-after-complete-deduped': readdDeduped,
        schedulers,
        'scheduler-upserts': 2,
        'scheduled-runs': scheduledRuns,
        'observe-ms': OBSERVE_MS,
      },
      ok:
        noeviction === 1 &&
        attempts >= 3 &&
        completed === 1 &&
        added === 2 &&
        queued === 1 &&
        sameJob === 1 &&
        readdDeduped === 1 &&
        schedulers >= 1 &&
        scheduledRuns >= 2,
    };
  } finally {
    await worker?.close().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await Promise.all([
      producerConn.quit().catch(() => undefined),
      workerConn.quit().catch(() => undefined),
      pool.end().catch(() => undefined),
    ]);
  }
}

main().catch(fail);
