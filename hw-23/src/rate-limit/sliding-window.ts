import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Sliding-window log in ONE script: trim, count and add must be atomic, or a
 * second pod slips in between ZCARD and ZADD exactly under load. The clock is
 * Redis TIME, so pods with skewed clocks still share one window.
 * Returns {allowed, remaining, retryAfterMs}.
 */
const SLIDING_WINDOW = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}`;

export type RateLimitConfig = { limit: number; windowMs: number };

export type RateLimitDecision = { allowed: boolean; remaining: number; retryAfterMs: number };

export function rateLimitConfigFromEnv(): RateLimitConfig {
  return {
    limit: positiveInt(process.env.RATE_LIMIT_LIMIT, 60),
    windowMs: positiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  };
}

export class SlidingWindowLimiter {
  constructor(
    private readonly redis: Redis,
    readonly config: RateLimitConfig,
  ) {}

  async hit(key: string): Promise<RateLimitDecision> {
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(
      SLIDING_WINDOW,
      1,
      key,
      String(this.config.windowMs),
      String(this.config.limit),
      randomUUID(),
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
