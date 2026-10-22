import {
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationShutdown,
  RequestMethod,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import {
  CARD_CACHE_OPTIONS,
  ProductCardRepository,
  ProductCardService,
} from '../products/product-card';
import { ProductCardController } from '../products/product-card.controller';
import { RATE_LIMITER, RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { rateLimitConfigFromEnv, SlidingWindowLimiter } from '../rate-limit/sliding-window';
import { SessionController } from '../session/session.controller';
import { SessionMiddleware } from '../session/session.middleware';
import { SessionStore } from '../session/session.store';
import { connectCacheRedis, connectStateRedis } from './clients';
import { SingleFlightCache } from './single-flight-cache';

export const CACHE_REDIS = Symbol('CACHE_REDIS');
export const STATE_REDIS = Symbol('STATE_REDIS');

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(CACHE_REDIS) private readonly cache: Redis,
    @Inject(STATE_REDIS) private readonly state: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.cache.quit().catch(() => undefined), this.state.quit().catch(() => undefined)]);
  }
}

/** Card cache, sessions and rate limit. Loaded only when both Redis URLs are set. */
@Module({
  providers: [
    { provide: CACHE_REDIS, useFactory: connectCacheRedis },
    { provide: STATE_REDIS, useFactory: connectStateRedis },
    {
      provide: ProductCardService,
      inject: [CACHE_REDIS, DataSource],
      useFactory: (redis: Redis, ds: DataSource) =>
        new ProductCardService(
          new ProductCardRepository(ds),
          new SingleFlightCache(redis, CARD_CACHE_OPTIONS),
        ),
    },
    {
      provide: SessionStore,
      inject: [STATE_REDIS],
      useFactory: (redis: Redis) => new SessionStore(redis),
    },
    {
      provide: RATE_LIMITER,
      inject: [STATE_REDIS],
      useFactory: (redis: Redis) => new SlidingWindowLimiter(redis, rateLimitConfigFromEnv()),
    },
    RateLimitGuard,
    RedisShutdown,
  ],
  controllers: [ProductCardController, SessionController],
})
export class RedisFeaturesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
