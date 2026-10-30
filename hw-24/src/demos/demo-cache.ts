import {
  CARD_CACHE_OPTIONS,
  cardKey,
  PRODUCT_CARD_SQL_TAG,
  ProductCardRepository,
  ProductCardService,
} from '../products/product-card';
import { QueryTagCounter } from '../query-tag-counter';
import { configGet, connectCacheRedis } from '../redis/clients';
import { SingleFlightCache } from '../redis/single-flight-cache';
import { fail, report, sleep } from './demo-kit';
import { DEMO_PRODUCT_FIRST_ID, deleteKeys, prepareDb } from './redis-kit';

const WARM_KEYS = 60;
const CONCURRENT = 50;
const WARM_READS = 100;
/** Above the old fixed 3 s wait, below CARD_CACHE_OPTIONS.lockTtlMs. */
const SLOW_LOAD_MS = 3500;

/**
 * Cache-aside on the product card. db-calls is counted at the driver: a
 * TypeORM logger sees every SQL statement that starts with the card tag.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  const counter = new QueryTagCounter(PRODUCT_CARD_SQL_TAG);
  const ds = await prepareDb(WARM_KEYS, { logger: counter, logging: ['query'] });
  const redis = await connectCacheRedis();
  try {
    const policy = await configGet(redis, 'maxmemory-policy');
    const maxmemory = Number(await configGet(redis, 'maxmemory'));

    await deleteKeys(redis, 'product:card:*');
    await deleteKeys(redis, 'lock:product:card:*');

    const cards = new ProductCardService(
      new ProductCardRepository(ds),
      new SingleFlightCache(redis, CARD_CACHE_OPTIONS),
    );
    const ids = Array.from({ length: WARM_KEYS }, (_, i) => DEMO_PRODUCT_FIRST_ID + i);

    // 1) Warm 60 keys, then look at how their TTLs are spread.
    for (const id of ids) await cards.get(id);
    const ttls = await Promise.all(ids.map((id) => redis.ttl(cardKey(id))));
    const warmed = ttls.filter((t) => t > 0).length;
    const ttlDistinct = new Set(ttls.filter((t) => t > 0)).size;

    // 2) Stampede: the hot key just expired, 50 requests arrive at once.
    const hot = ids[0];
    await redis.del(cardKey(hot));
    counter.reset();
    const results = await Promise.all(Array.from({ length: CONCURRENT }, () => cards.get(hot)));
    const dbCalls = counter.count;
    const allServed = results.every((c) => c?.id === hot) ? 1 : 0;
    const lockLeft = await redis.exists(`lock:${cardKey(hot)}`);

    // 2b) Same stampede, but the DB read is slow (longer than any fixed wait,
    // shorter than the lock TTL): waiters must keep waiting, not hit the DB.
    const slow = ids[1];
    const repo = new ProductCardRepository(ds);
    const slowCache = new SingleFlightCache(redis, CARD_CACHE_OPTIONS);
    await redis.del(cardKey(slow));
    counter.reset();
    const slowResults = await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        slowCache.getOrLoad(cardKey(slow), async () => {
          await sleep(SLOW_LOAD_MS);
          return repo.load(slow);
        }),
      ),
    );
    const slowDbCalls = counter.count;
    const slowServed = slowResults.every((c) => c?.id === slow) ? 1 : 0;

    // 3) 100 reads of a warm cache.
    counter.reset();
    for (let i = 0; i < WARM_READS; i += 1) await cards.get(ids[i % ids.length]);
    const dbCallsWarm = counter.count;

    const cacheLru = policy !== null && policy !== 'noeviction' ? 1 : 0;
    const cacheMaxmemory = maxmemory > 0 ? 1 : 0;

    return {
      lines: {
        'cache-lru': cacheLru,
        'cache-maxmemory': cacheMaxmemory,
        'cache-maxmemory-mb': Math.round(maxmemory / 1024 / 1024),
        warmed,
        'ttl-distinct': ttlDistinct,
        'ttl-min': Math.min(...ttls),
        'ttl-max': Math.max(...ttls),
        concurrent: CONCURRENT,
        'all-served': allServed,
        'db-calls': dbCalls,
        'lock-left': lockLeft,
        'slow-load-ms': SLOW_LOAD_MS,
        'slow-db-calls': slowDbCalls,
        'slow-all-served': slowServed,
        'warm-reads': WARM_READS,
        'db-calls-warm': dbCallsWarm,
      },
      ok:
        cacheLru === 1 &&
        cacheMaxmemory === 1 &&
        warmed >= 50 &&
        ttlDistinct >= 5 &&
        allServed === 1 &&
        dbCalls === 1 &&
        lockLeft === 0 &&
        slowDbCalls === 1 &&
        slowServed === 1 &&
        dbCallsWarm === 0,
    };
  } finally {
    await redis.quit().catch(() => undefined);
    await ds.destroy().catch(() => undefined);
  }
}

main().catch(fail);
