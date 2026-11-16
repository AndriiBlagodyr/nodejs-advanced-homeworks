import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 30 * 60 * 1000;

export type SessionData = {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  requests: number;
};

/**
 * Touch = renew TTL + bump activity, atomically and only for a live session:
 * an expired session is never resurrected by a late request.
 */
const TOUCH = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HSET', KEYS[1], 'lastSeenAt', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return redis.call('HGETALL', KEYS[1])`;

/**
 * Sessions live in the noeviction instance: under allkeys-lru the cache
 * would one day evict a live session and log the user out at random.
 * Keys hold sha256(sid), so a Redis dump does not contain usable tokens.
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs = SESSION_TTL_MS,
  ) {}

  static keyFor(sid: string): string {
    return `session:${createHash('sha256').update(sid).digest('hex')}`;
  }

  async create(userId: string): Promise<{ sid: string; data: SessionData }> {
    const sid = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const data: SessionData = { userId, createdAt: now, lastSeenAt: now, requests: 1 };
    await this.redis
      .multi()
      .hset(SessionStore.keyFor(sid), {
        userId: data.userId,
        createdAt: data.createdAt,
        lastSeenAt: data.lastSeenAt,
        requests: String(data.requests),
      })
      .pexpire(SessionStore.keyFor(sid), this.ttlMs)
      .exec();
    return { sid, data };
  }

  async touch(sid: string): Promise<SessionData | null> {
    const flat = (await this.redis.eval(
      TOUCH,
      1,
      SessionStore.keyFor(sid),
      String(this.ttlMs),
      new Date().toISOString(),
    )) as string[] | null;
    if (!flat) return null;
    const h: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) h[flat[i]] = flat[i + 1];
    return {
      userId: h.userId,
      createdAt: h.createdAt,
      lastSeenAt: h.lastSeenAt,
      requests: Number(h.requests),
    };
  }

  async destroy(sid: string): Promise<void> {
    await this.redis.del(SessionStore.keyFor(sid));
  }
}
