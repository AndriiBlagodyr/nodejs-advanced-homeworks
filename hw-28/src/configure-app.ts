import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { Express } from 'express';

/**
 * Which hops may set X-Forwarded-For / X-Forwarded-Proto. req.ip (rate-limit
 * key) and req.secure (session cookie) depend on it. Not `true`: with no
 * proxy in front, any client could forge X-Forwarded-For and get a fresh
 * rate-limit window per request. Default trusts proxies on private networks
 * (ingress / load balancer / sidecar); TRUST_PROXY takes the Express syntax:
 * a hop count, `true`/`false`, or a list of addresses/subnets.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export function trustProxySetting(raw = process.env.TRUST_PROXY): boolean | number | string {
  const value = raw?.trim() || DEFAULT_TRUST_PROXY;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function configureApp(app: INestApplication): void {
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', trustProxySetting());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
}
