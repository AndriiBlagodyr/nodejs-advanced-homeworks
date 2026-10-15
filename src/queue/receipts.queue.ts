import { type Job, type JobsOptions, Queue, UnrecoverableError } from 'bullmq';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PURGE_INTERVAL_MS, purgeOutbox } from '../outbox/retention';

export const RECEIPTS_QUEUE = 'receipts';
export const JOB_SEND_RECEIPT = 'send-receipt';
export const JOB_OUTBOX_PURGE = 'outbox-purge';
export const OUTBOX_PURGE_SCHEDULER = 'outbox-purge';

/**
 * removeOnComplete is an age, not `true`: a removed job no longer counts as a
 * duplicate, so `true` would silently switch jobId dedup off. One day is
 * longer than any window in which the same order.placed can be redelivered.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export type SendReceiptData = {
  orderId: string;
  userId: string;
  totalCents: number;
  /** Demo only: fail this many attempts before succeeding. */
  failTimes?: number;
};

export function createReceiptsQueue(connection: Redis, name = RECEIPTS_QUEUE): Queue {
  return new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
}

export function receiptJobId(orderId: string): string {
  return `receipt-${orderId}`;
}

/** Same order → same jobId → one job, however many times this is called. */
export function enqueueReceipt(queue: Queue, data: SendReceiptData, opts: JobsOptions = {}) {
  return queue.add(JOB_SEND_RECEIPT, data, { ...opts, jobId: receiptJobId(data.orderId) });
}

/** upsert, not add: every restart re-applies the same scheduler instead of adding one more. */
export function upsertOutboxPurgeScheduler(queue: Queue, everyMs = PURGE_INTERVAL_MS) {
  return queue.upsertJobScheduler(
    OUTBOX_PURGE_SCHEDULER,
    { every: everyMs },
    {
      name: JOB_OUTBOX_PURGE,
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000, jitter: 0.5 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    },
  );
}

export function createReceiptsProcessor(deps: { pool: Pool }) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case JOB_SEND_RECEIPT: {
        const data = job.data as SendReceiptData;
        if (data.failTimes && job.attemptsMade < data.failTimes) {
          throw new Error(`receipt provider unavailable (attempt ${job.attemptsMade + 1})`);
        }
        // A real mailer gets job.id as its idempotency key, so a retry after
        // a lost ack cannot send the receipt twice.
        return { orderId: data.orderId, sentTo: data.userId, idempotencyKey: job.id };
      }
      case JOB_OUTBOX_PURGE:
        return purgeOutbox(deps.pool);
      default:
        throw new UnrecoverableError(`unknown job ${job.name}`);
    }
  };
}
