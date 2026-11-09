import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from './context';
import { childLogger } from './logger';
import { httpDuration, httpRequests, routeTemplate } from './metrics';

const skipLog = new Set(['/metrics', '/healthz', '/readyz']);
const log = childLogger('http');

export function requestPath(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0];
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

/** ALS: tenant and Idempotency-Key from headers. userId is patched in the auth guard. */
export function contextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  runWithContext(
    {
      tenant: header(req, 'x-tenant'),
      idempotencyKey: header(req, 'idempotency-key'),
    },
    () => next(),
  );
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = requestPath(req);
  if (skipLog.has(path)) {
    next();
    return;
  }
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: routeTemplate(req),
      status: String(res.statusCode),
    };
    httpRequests.inc(labels);
    httpDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
}

/**
 * Logs the request without taking `req` in any business function. The object
 * is shaped so redact paths (`req.headers.authorization`, `req.body.password`)
 * match; anything not listed stays visible.
 */
export function requestLogMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const path = requestPath(req);
  if (!skipLog.has(path)) {
    log.info(
      {
        req: {
          method: req.method,
          url: req.originalUrl ?? req.url,
          headers: { authorization: req.headers.authorization },
          // Login and refresh bodies (HW-24) stay out entirely. Redact paths
          // still cover a password that a non-auth log happens to include.
          body: path.startsWith('/auth/') ? undefined : req.body,
        },
      },
      'request',
    );
  }
  next();
}
