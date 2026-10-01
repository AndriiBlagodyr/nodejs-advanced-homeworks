import { DataSource } from 'typeorm';
import { createDataSourceOptions } from './data-source';
import { runWorkerPool } from './workers';

const JOB_COUNT = 20;
const WORKER_COUNT = 4;
const WORK_MS = 40;

async function seedJobs(ds: DataSource): Promise<void> {
  // Only drop leftovers from prior worker-demo runs; keep checkout receipts intact.
  await ds.query(`DELETE FROM jobs WHERE payload->>'demo' = 'workers'`);

  for (let i = 0; i < JOB_COUNT; i += 1) {
    await ds.query(
      `INSERT INTO jobs (type, payload, status)
       VALUES ('send_receipt', $1::jsonb, 'pending')`,
      [JSON.stringify({ demo: 'workers', n: i + 1 })],
    );
  }
}

async function main(): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();

  try {
    await seedJobs(ds);

    const sequentialEstimateMs = JOB_COUNT * WORK_MS;
    const { stats, elapsedMs } = await runWorkerPool(ds, {
      workerCount: WORKER_COUNT,
      workMs: WORK_MS,
      idlePollsBeforeExit: 5,
      pollDelayMs: 10,
    });

    const processedRows: Array<{ id: string; processed: number; worker_id: string }> =
      await ds.query(
        `SELECT id, processed, worker_id
           FROM jobs
          WHERE payload->>'demo' = 'workers'
          ORDER BY id`,
      );

    const totalProcessed = processedRows.reduce(
      (sum, row) => sum + Number(row.processed),
      0,
    );
    const processedTwice = processedRows.filter(
      (row) => Number(row.processed) > 1,
    ).length;
    const workersUsed = stats.filter((s) => s.processed > 0).length;

    console.log('demo:workers');
    console.log(`jobs: ${JOB_COUNT}`);
    console.log(`workers: ${WORKER_COUNT}`);
    console.log(
      `distribution: ${stats.map((s) => `${s.workerId}=${s.processed}`).join(', ')}`,
    );
    console.log(`processed twice: ${processedTwice}`);
    console.log(`total processed counter: ${totalProcessed}`);
    console.log(`elapsed ms: ${elapsedMs}`);
    console.log(`sequential estimate ms: ${sequentialEstimateMs}`);

    const ok =
      processedTwice === 0 &&
      totalProcessed === JOB_COUNT &&
      workersUsed >= 2 &&
      elapsedMs < sequentialEstimateMs;

    if (!ok) {
      console.error('worker pool invariant failed');
      process.exit(1);
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
