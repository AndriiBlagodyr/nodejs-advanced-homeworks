import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/** Compare-and-delete: only the holder's token removes the lock. Works on any Redis version. */
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** SET key token NX PX ttl. Returns the token when this caller won, otherwise null. */
export async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return ok === 'OK' ? token : null;
}

/**
 * A plain DEL would remove a lock that already expired and was taken by
 * someone else; comparing the token makes the release safe.
 */
export async function releaseLock(redis: Redis, key: string, token: string): Promise<boolean> {
  return (await redis.eval(RELEASE_IF_OWNER, 1, key, token)) === 1;
}
