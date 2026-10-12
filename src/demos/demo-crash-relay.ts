import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { placeOrder } from '../orders/place-order';
import { countUnpublished, drainOutbox } from '../outbox/relay';
import { counts, DEMO_PRODUCT_ID, DEMO_USER_ID, fail, report, sleep, waitFor, withDemo } from './demo-kit';

/**
 * A separate relay process is SIGKILLed between the broker confirm and
 * UPDATE published_at. A second relay publishes the same event again; the
 * consumer sees two deliveries and applies the effect once.
 */
async function main(): Promise<void> {
  const result = await withDemo(async ({ ds, pool, relayCh, stats }) => {
    await placeOrder(ds, {
      userId: DEMO_USER_ID,
      items: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }],
      idempotencyKey: `demo-crash-relay-${randomUUID()}`,
    });

    const crashed = await runCrashingRelay();
    await waitFor(() => stats.deliveries >= 1);
    const unpublishedAfterCrash = await countUnpublished(pool);

    const secondRun = await drainOutbox(pool, relayCh);
    await waitFor(() => stats.applied + stats.skipped >= 2);
    await sleep(500);

    return { crashed, unpublishedAfterCrash, secondRun, stats: { ...stats }, c: await counts(pool) };
  });

  const { crashed, unpublishedAfterCrash, secondRun, stats, c } = result;
  const relayKilled = crashed.signal === 'SIGKILL' ? 1 : 0;
  report(
    {
      'relay-killed': relayKilled,
      'unpublished-after-crash': unpublishedAfterCrash,
      published: crashed.published + secondRun,
      deliveries: stats.deliveries,
      applied: stats.applied,
      skipped: stats.skipped,
      effect: c.effect,
      processed: c.processed,
      'outbox-published': c.outboxPublished,
    },
    relayKilled === 1 &&
      unpublishedAfterCrash === 1 &&
      stats.deliveries >= 2 &&
      stats.applied === 1 &&
      c.effect === 1 &&
      c.processed === 1 &&
      c.outboxPublished === 1,
  );
}

function runCrashingRelay(): Promise<{ signal: NodeJS.Signals | null; published: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, '..', 'outbox', 'relay-main.js')], {
      env: { ...process.env, RELAY_ONCE: '1', RELAY_CRASH_AFTER_PUBLISH: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (_code, signal) => {
      const match = /relay-published=(\d+)/.exec(out);
      resolve({ signal, published: match ? Number(match[1]) : 0 });
    });
  });
}

main().catch(fail);
