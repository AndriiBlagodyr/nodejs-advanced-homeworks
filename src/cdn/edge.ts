import { createServer, type Server } from 'node:http';
import type { Storage, StoredObject } from '../storage/storage';

type Entry = { obj: StoredObject; expiresAt: number };

export type EdgeStats = { hits: number; misses: number; originFetches: number };

/**
 * The local stand-in for CloudFront + OAC. The bucket is private; the edge
 * reads it with its own credentials, so the public reaches the cache and
 * only the cache reaches storage. What is cached and for how long is decided
 * by the object's own Cache-Control, set at upload time. Without it nothing
 * is cached. Only `assets/` is served; user uploads never go through here.
 */
export function createEdge(
  storage: Storage,
  opts: { maxEntries?: number; maxObjectBytes?: number } = {},
) {
  const maxEntries = opts.maxEntries ?? 1000;
  const maxObjectBytes = opts.maxObjectBytes ?? 10 * 1024 * 1024;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<StoredObject | null>>();
  const stats: EdgeStats = { hits: 0, misses: 0, originFetches: 0 };

  const server: Server = createServer((req, res) => {
    void (async () => {
      let key: string;
      try {
        key = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (req.method !== 'GET' || !key.startsWith('assets/') || key.split('/').includes('..')) {
        res.writeHead(404).end();
        return;
      }

      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        stats.hits += 1;
        cache.delete(key);
        cache.set(key, cached); // LRU: most recent last
        send(res, cached.obj, 'HIT');
        return;
      }

      stats.misses += 1;
      // One origin fetch per key, however many requests miss at once.
      let pending = inflight.get(key);
      if (!pending) {
        stats.originFetches += 1;
        pending = storage.get(key).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const obj = await pending;
      if (!obj) {
        res.writeHead(404, { 'x-cache': 'MISS' }).end();
        return;
      }
      const ttl = cacheableSeconds(obj.cacheControl);
      if (ttl > 0 && obj.body.length <= maxObjectBytes) {
        cache.set(key, { obj, expiresAt: Date.now() + ttl * 1000 });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      }
      send(res, obj, 'MISS');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  return { server, stats };
}

function send(res: import('node:http').ServerResponse, obj: StoredObject, xCache: 'HIT' | 'MISS') {
  const headers: Record<string, string> = { 'x-cache': xCache };
  if (obj.contentType) headers['content-type'] = obj.contentType;
  if (obj.cacheControl) headers['cache-control'] = obj.cacheControl;
  if (obj.etag) headers.etag = obj.etag;
  res.writeHead(200, headers).end(obj.body);
}

/** Shared-cache TTL from the origin header: `public` + `max-age`, unless no-store/private/no-cache. */
export function cacheableSeconds(cacheControl: string | undefined): number {
  if (!cacheControl) return 0;
  const directives = cacheControl.toLowerCase().split(',').map((d) => d.trim());
  if (directives.some((d) => d === 'no-store' || d === 'private' || d === 'no-cache')) return 0;
  if (!directives.includes('public')) return 0;
  const sMaxAge = directives.find((d) => d.startsWith('s-maxage='));
  const maxAge = directives.find((d) => d.startsWith('max-age='));
  const value = Number((sMaxAge ?? maxAge)?.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
