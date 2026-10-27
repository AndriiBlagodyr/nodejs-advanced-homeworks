import { connectStateRedis } from '../redis/clients';
import { fail, report } from './demo-kit';
import { bootApp, DEMO_PRODUCT_FIRST_ID, deleteKeys, prepareDb, type RunningApp } from './redis-kit';

const LIMIT = 5;
const WINDOW_MS = 10_000;
const PODS = 2;
const REQUESTS = 12;

/**
 * Two independent app instances share one sliding window in Redis. Requests
 * alternate between them; an in-memory limiter would let 2 × LIMIT through.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  process.env.RATE_LIMIT_LIMIT = String(LIMIT);
  process.env.RATE_LIMIT_WINDOW_MS = String(WINDOW_MS);

  const ds = await prepareDb(1);
  await ds.destroy();
  const redis = await connectStateRedis();
  const pods: RunningApp[] = [];
  try {
    await deleteKeys(redis, 'rl:*');
    for (let i = 0; i < PODS; i += 1) pods.push(await bootApp());

    let allowed = 0;
    let blocked = 0;
    let lastBlockedStatus = 0;
    let retryAfter = 0;
    let retryAfterSeconds = 0;
    const perPod = pods.map(() => 0);
    for (let i = 0; i < REQUESTS; i += 1) {
      const podIndex = i % PODS;
      const res = await fetch(`${pods[podIndex].base}/products/${DEMO_PRODUCT_FIRST_ID}/card`);
      await res.arrayBuffer();
      if (res.status === 200) {
        allowed += 1;
        perPod[podIndex] += 1;
      } else if (res.status === 429) {
        blocked += 1;
        lastBlockedStatus = res.status;
        const header = res.headers.get('retry-after');
        retryAfter = header !== null ? 1 : 0;
        retryAfterSeconds = Number(header ?? 0);
      } else {
        throw new Error(`unexpected status ${res.status}`);
      }
    }

    // Behind a proxy the TCP peer is the proxy (127.0.0.1 here, trusted). The
    // direct client is already blocked; two different end clients forwarded by
    // the proxy must still get their own windows.
    const viaProxy = await Promise.all(
      ['203.0.113.10', '203.0.113.11'].map(async (client, i) => {
        const res = await fetch(`${pods[i % PODS].base}/products/${DEMO_PRODUCT_FIRST_ID}/card`, {
          headers: { 'x-forwarded-for': client },
        });
        await res.arrayBuffer();
        return res.status;
      }),
    );
    const proxiedSeparate = viaProxy.every((s) => s === 200) ? 1 : 0;

    return {
      lines: {
        instances: pods.length,
        limit: LIMIT,
        'window-ms': WINDOW_MS,
        requests: REQUESTS,
        allowed,
        blocked,
        'allowed-pod-a': perPod[0],
        'allowed-pod-b': perPod[1],
        status: lastBlockedStatus,
        'retry-after': retryAfter,
        'retry-after-seconds': retryAfterSeconds,
        'proxied-clients-separate': proxiedSeparate,
      },
      ok:
        pods.length >= 2 &&
        allowed === LIMIT &&
        blocked >= 1 &&
        lastBlockedStatus === 429 &&
        retryAfter === 1 &&
        retryAfterSeconds >= 1 &&
        proxiedSeparate === 1,
    };
  } finally {
    for (const pod of pods) await pod.app.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

main().catch(fail);
