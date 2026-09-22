import type { DataSource, EntityManager } from 'typeorm';
import { returningRows } from './db-result';

export type ClaimedJob = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  order_id: string | null;
};

export type WorkerStats = {
  workerId: string;
  processed: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claim one pending job with FOR UPDATE SKIP LOCKED and keep the row locked
 * until the surrounding transaction commits.
 */
export async function claimNextJob(
  manager: EntityManager,
): Promise<ClaimedJob | null> {
  const rows = returningRows<ClaimedJob>(
    await manager.query(
      `SELECT id, type, payload, order_id
         FROM jobs
        WHERE status = 'pending'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    ),
  );
  return rows[0] ?? null;
}

export async function completeJob(
  manager: EntityManager,
  jobId: string,
  workerId: string,
): Promise<void> {
  await manager.query(
    `UPDATE jobs
        SET status = 'done',
            processed = processed + 1,
            worker_id = $2,
            processed_at = now()
      WHERE id = $1`,
    [jobId, workerId],
  );
}

export type RunWorkersOptions = {
  workerCount: number;
  /** Simulated post-processing work while the row lock is held. */
  workMs?: number;
  /** Empty-claim polls before a worker exits. */
  idlePollsBeforeExit?: number;
  pollDelayMs?: number;
};

export async function runWorkerPool(
  ds: DataSource,
  options: RunWorkersOptions,
): Promise<{ stats: WorkerStats[]; elapsedMs: number }> {
  const workMs = options.workMs ?? 40;
  const idlePollsBeforeExit = options.idlePollsBeforeExit ?? 3;
  const pollDelayMs = options.pollDelayMs ?? 15;
  const started = Date.now();

  const stats: WorkerStats[] = Array.from(
    { length: options.workerCount },
    (_, index) => ({
      workerId: `worker-${index + 1}`,
      processed: 0,
    }),
  );

  await Promise.all(
    stats.map(async (stat) => {
      let idlePolls = 0;
      while (idlePolls < idlePollsBeforeExit) {
        const claimed = await ds.transaction(async (manager) => {
          const job = await claimNextJob(manager);
          if (!job) {
            return null;
          }
          await sleep(workMs);
          await completeJob(manager, job.id, stat.workerId);
          return job;
        });

        if (!claimed) {
          idlePolls += 1;
          await sleep(pollDelayMs);
          continue;
        }

        idlePolls = 0;
        stat.processed += 1;
      }
    }),
  );

  return { stats, elapsedMs: Date.now() - started };
}
