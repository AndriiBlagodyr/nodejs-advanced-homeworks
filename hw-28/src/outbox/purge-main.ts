import { createPool } from './pg';
import { purgeOutbox } from './retention';

/** One-shot retention sweep (cron / k8s CronJob). */
async function main(): Promise<void> {
  const pool = createPool();
  try {
    const { outbox, processed } = await purgeOutbox(pool);
    console.log(`purged-outbox=${outbox}`);
    console.log(`purged-processed=${processed}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
