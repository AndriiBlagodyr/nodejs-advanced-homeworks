import Redis, { type RedisOptions } from 'ioredis';

/** Cache instance: maxmemory + allkeys-lru. Anything here may vanish at any time. */
export function cacheRedisUrl(): string {
  return requireEnv('REDIS_URL');
}

/** Queue/state instance: noeviction + AOF. BullMQ, sessions, rate-limit counters. */
export function queueRedisUrl(): string {
  return requireEnv('REDIS_QUEUE_URL');
}

export function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_QUEUE_URL);
}

/**
 * Request-path clients fail fast instead of queueing commands while Redis is
 * away: a slow cache must not make the request slower than the database.
 */
const FAIL_FAST: RedisOptions = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
  commandTimeout: 1000,
};

export function connectCacheRedis(): Promise<Redis> {
  return connect('cache', cacheRedisUrl(), FAIL_FAST);
}

export function connectStateRedis(): Promise<Redis> {
  return connect('state', queueRedisUrl(), FAIL_FAST);
}

/** For BullMQ Queue (producer): failing fast on add() is the right behaviour. */
export function connectQueueProducerRedis(): Promise<Redis> {
  return connect('queue', queueRedisUrl(), { enableOfflineQueue: false });
}

/** For BullMQ Worker: wait for Redis instead of throwing on a dropped connection. */
export function connectQueueWorkerRedis(): Promise<Redis> {
  return connect('queue-worker', queueRedisUrl(), { maxRetriesPerRequest: null });
}

async function connect(name: string, url: string, opts: RedisOptions): Promise<Redis> {
  const client = new Redis(url, { lazyConnect: true, ...opts });
  let lastLogged = 0;
  client.on('error', (err: Error) => {
    if (Date.now() - lastLogged > 5000) {
      lastLogged = Date.now();
      console.warn(`[redis:${name}] ${err.message}`);
    }
  });
  // Do not block startup on Redis: ioredis keeps reconnecting in the background.
  await client.connect().catch(() => undefined);
  return client;
}

export async function configGet(redis: Redis, key: string): Promise<string | null> {
  const res = (await redis.config('GET', key)) as string[];
  return res.length >= 2 ? res[1] : null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}: unbound variable`);
  return value;
}
