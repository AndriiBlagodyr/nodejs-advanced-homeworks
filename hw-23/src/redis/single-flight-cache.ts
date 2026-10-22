import { randomInt } from 'node:crypto';
import type Redis from 'ioredis';
import { acquireLock, releaseLock } from './lock';

export type SingleFlightOptions = {
  /** TTL = ttlBaseSec + random(0..ttlJitterSec), so one warm-up never expires in one second. */
  ttlBaseSec: number;
  ttlJitterSec: number;
  /** Short TTL for "not found", so a missing id cannot hammer the DB either. */
  negativeTtlBaseSec: number;
  negativeTtlJitterSec: number;
  /**
   * Lock lifetime; must exceed the slowest expected load. Waiters wait as long
   * as the lock lives, so this is also the longest a waiter can wait before
   * one of them takes over a dead holder's work.
   */
  lockTtlMs: number;
  pollMs: number;
};

type Read<T> = { kind: 'hit'; value: T | null } | { kind: 'miss' } | { kind: 'down' };

/**
 * Cache-aside with a single-flight lock. On a miss, one caller wins
 * SET lock NX PX and loads; the rest poll the cache while the lock exists.
 * When the lock is gone without a value (holder crashed, load failed, TTL ran
 * out), the next SET NX elects exactly one new loader. The lock is an
 * optimisation: if it ever fails, the cost is an extra DB read, never wrong
 * data. Any Redis error degrades to reading the DB directly.
 */
export class SingleFlightCache {
  constructor(
    private readonly redis: Redis,
    private readonly opts: SingleFlightOptions,
  ) {}

  async getOrLoad<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const first = await this.read<T>(key);
    if (first.kind === 'hit') return first.value;
    if (first.kind === 'down') return load();

    const lockKey = `lock:${key}`;
    for (;;) {
      let token: string | null;
      try {
        token = await acquireLock(this.redis, lockKey, this.opts.lockTtlMs);
      } catch {
        return load();
      }

      if (token) {
        try {
          // Someone may have filled the key between our miss and our lock.
          const again = await this.read<T>(key);
          if (again.kind === 'hit') return again.value;
          const value = await load();
          await this.write(key, value);
          return value;
        } finally {
          await releaseLock(this.redis, lockKey, token).catch(() => undefined);
        }
      }

      // No wall-clock deadline: a slow load must not release the waiters onto the DB.
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
      const polled = await this.read<T>(key);
      if (polled.kind === 'hit') return polled.value;
      if (polled.kind === 'down') return load();
    }
  }

  async invalidate(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.del(...keys).catch(() => undefined);
  }

  ttlSeconds(found: boolean): number {
    return found
      ? this.opts.ttlBaseSec + randomInt(0, this.opts.ttlJitterSec + 1)
      : this.opts.negativeTtlBaseSec + randomInt(0, this.opts.negativeTtlJitterSec + 1);
  }

  private async read<T>(key: string): Promise<Read<T>> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch {
      return { kind: 'down' };
    }
    if (raw === null) return { kind: 'miss' };
    try {
      return { kind: 'hit', value: (JSON.parse(raw) as { v: T | null }).v };
    } catch {
      return { kind: 'miss' };
    }
  }

  /** A failed write (OOM, Redis away) must never fail the user's request. */
  private async write<T>(key: string, value: T | null): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify({ v: value }), 'EX', this.ttlSeconds(value !== null));
    } catch {
      /* cache is best-effort */
    }
  }
}
