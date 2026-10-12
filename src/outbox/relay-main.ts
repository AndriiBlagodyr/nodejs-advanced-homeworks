import { writeSync } from 'node:fs';
import { connectBroker } from '../broker/connection';
import { createPool } from './pg';
import { RELAY_POLL_MS, relayBatch, type RelayOptions } from './relay';

/**
 * Relay worker process. Env switches:
 *   RELAY_ONCE=1                 — one batch, then exit
 *   RELAY_CRASH_AFTER_PUBLISH=1  — SIGKILL itself after the broker confirmed
 *                                  the batch and before UPDATE published_at
 */
async function main(): Promise<void> {
  const once = process.env.RELAY_ONCE === '1';
  const crashAfterPublish = process.env.RELAY_CRASH_AFTER_PUBLISH === '1';

  const pool = createPool();
  const conn = await connectBroker();
  const ch = await conn.createConfirmChannel();

  const opts: RelayOptions = crashAfterPublish
    ? {
        afterPublish: (rows) => {
          writeSync(1, `relay-published=${rows.length}\n`);
          process.kill(process.pid, 'SIGKILL');
        },
      }
    : {};

  let stopping = false;
  process.once('SIGTERM', () => {
    stopping = true;
  });
  process.once('SIGINT', () => {
    stopping = true;
  });

  do {
    const n = await relayBatch(pool, ch, opts);
    if (n > 0) writeSync(1, `relay-published=${n}\n`);
    if (!once && n === 0) await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
  } while (!once && !stopping);

  await ch.close();
  await conn.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
