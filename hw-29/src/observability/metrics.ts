import type { Request } from 'express';
import { Counter, Histogram, Registry } from 'prom-client';
import {
  DURATION_BUCKETS_SECONDS,
  HTTP_REQUEST_DURATION,
  HTTP_REQUESTS_TOTAL,
} from './config';

export const register = new Registry();

export const httpRequests = new Counter({
  name: HTTP_REQUESTS_TOTAL,
  help: 'HTTP requests, labeled with the route template (not the raw path).',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

export const httpDuration = new Histogram({
  name: HTTP_REQUEST_DURATION,
  help: 'HTTP request duration in seconds. Finite upper bucket covers the slowest demo request.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: DURATION_BUCKETS_SECONDS,
  registers: [register],
});

/**
 * Nest/Express: `req.route.path` is the matched pattern (`/products/:productId`),
 * `req.baseUrl` the controller mount. Together they stay a template when the
 * raw URL has a hundred different ids.
 */
export function routeTemplate(req: Request): string {
  const path = req.route?.path;
  if (typeof path !== 'string' || path.length === 0) return 'unmatched';
  const base = req.baseUrl ?? '';
  const full = `${base}${path}`.replace(/\/{2,}/g, '/') || '/';
  return full.startsWith('/') ? full : `/${full}`;
}
