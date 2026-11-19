import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Storage, StoredObject } from '../storage/storage';

type Entry = { obj: StoredObject; expiresAt: number };

export type EdgeStats = {
  hits: number;
  misses: number;
  originFetches: number;
  /** Body bytes currently held in the cache; never above `maxBytes`. */
  cachedBytes: number;
  evictions: number;
};

export type EdgeOptions = {
  /** Memory budget for cached bodies. */
  maxBytes?: number;
  /** Larger objects are served but not cached, so one file cannot flush the rest. */
  maxObjectBytes?: number;
};

export const EDGE_MAX_BYTES = 64 * 1024 * 1024;
export const EDGE_MAX_OBJECT_BYTES = 10 * 1024 * 1024;

/**
 * The local stand-in for CloudFront + OAC. The bucket is private; the edge
 * reads it with its own credentials, so the public reaches the cache and
 * only the cache reaches storage. What is cached and for how long is decided
 * by the object's own Cache-Control, set at upload time. Without it nothing
 * is cached. Only `assets/` is served; user uploads never go through here.
 */
export function createEdge(storage: Storage, opts: EdgeOptions = {}) {
  const maxBytes = opts.maxBytes ?? EDGE_MAX_BYTES;
  const maxObjectBytes = Math.min(opts.maxObjectBytes ?? EDGE_MAX_OBJECT_BYTES, maxBytes);
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<StoredObject | null>>();
  const stats: EdgeStats = { hits: 0, misses: 0, originFetches: 0, cachedBytes: 0, evictions: 0 };

  const drop = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    stats.cachedBytes -= entry.obj.body.length;
  };

  const store = (key: string, entry: Entry) => {
    drop(key);
    cache.set(key, entry);
    stats.cachedBytes += entry.obj.body.length;
    // LRU by bytes: the Map's first key is the least recently used.
    while (stats.cachedBytes > maxBytes) {
      drop(cache.keys().next().value!);
      stats.evictions += 1;
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      let key: string;
      try {
        key = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }
      if (!key.startsWith('assets/') || key.split('/').includes('..')) {
        res.writeHead(404).end();
        return;
      }

      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        stats.hits += 1;
        store(key, cached); // move to most recent
        send(req, res, cached.obj, 'HIT');
        return;
      }
      if (cached) drop(key);

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
        store(key, { obj, expiresAt: Date.now() + ttl * 1000 });
      }
      send(req, res, obj, 'MISS');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  return { server, stats };
}

function send(req: IncomingMessage, res: ServerResponse, obj: StoredObject, xCache: 'HIT' | 'MISS') {
  const headers: Record<string, string> = { 'x-cache': xCache };
  if (obj.cacheControl) headers['cache-control'] = obj.cacheControl;
  if (obj.etag) headers.etag = obj.etag;
  if (obj.etag && etagMatches(req.headers['if-none-match'], obj.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  if (obj.contentType) headers['content-type'] = obj.contentType;
  headers['content-length'] = String(obj.body.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : obj.body);
}

/** `If-None-Match` uses the weak comparison (RFC 9110 §13.1.2): `W/` is ignored, `*` matches any. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = bare(etag);
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || bare(tag) === target);
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
