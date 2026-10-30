import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SlidingWindowLimiter } from './sliding-window';

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/**
 * Per-client limit shared by every pod through Redis. If Redis is down the
 * guard fails open: losing the limit for a while is better than an outage.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(@Inject(RATE_LIMITER) private readonly limiter: SlidingWindowLimiter) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    // req.ip is the client behind trusted proxies only (`trust proxy` in configure-app.ts).
    const key = `rl:${req.route?.path ?? req.path}:${req.ip ?? 'unknown'}`;

    let decision;
    try {
      decision = await this.limiter.hit(key);
    } catch (err) {
      this.logger.warn(`rate limiter unavailable, allowing: ${(err as Error).message}`);
      return true;
    }

    res.setHeader('RateLimit-Limit', String(this.limiter.config.limit));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));
    if (decision.allowed) return true;

    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    throw new HttpException(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too Many Requests' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
