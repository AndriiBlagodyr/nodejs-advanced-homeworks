import type { AddressInfo } from 'node:net';
import { createEdge } from '../cdn/edge';
import { IMMUTABLE, publishAsset } from '../cdn/assets';
import { storageFromEnv } from '../storage/storage';
import { fail, report } from './demo-kit';

const V1 = Buffer.from('/* hw26 v1 */ body { color: #1d4ed8; }\n');
const V2 = Buffer.from('/* hw26 v2 */ body { color: #b91c1c; }\n');
const PLAIN_KEY = 'assets/no-cache-control.txt';

/**
 * Private bucket, cache in front of it, content-hashed names. An anonymous
 * request straight at storage is 403; the edge reads with its own keys. A
 * "deploy" is a new object under a new name: zero invalidations, and the old
 * cache entry is simply never asked for again.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  const storage = storageFromEnv();
  await storage.ensureBucket();
  await storage.purgePrefix('assets/');

  const v1 = await publishAsset(storage, 'app.css', V1);
  const direct = await fetch(storage.directUrl(v1.key));
  await direct.arrayBuffer();

  // Control: the same edge, an object uploaded without Cache-Control.
  await storage.put(PLAIN_KEY, Buffer.from('plain\n'), { contentType: 'text/plain' });

  const { server, stats } = createEdge(storage);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const edge = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const miss = await get(edge, v1.path);
    const hit = await get(edge, v1.path);
    // `curl -I` and browser revalidation: both answered from the cache, no body, no origin trip.
    const head = await get(edge, v1.path, { method: 'HEAD' });
    const revalidate = await get(edge, v1.path, { headers: { 'if-none-match': hit.etag ?? '' } });

    await get(edge, `/${PLAIN_KEY}`);
    const plainAgain = await get(edge, `/${PLAIN_KEY}`);

    // Deploy: new content, new name. Nothing is purged from the cache.
    const v2 = await publishAsset(storage, 'app.css', V2);
    const fresh = await get(edge, v2.path);
    const old = await get(edge, v1.path);

    const lines = {
      direct: direct.status,
      'edge-miss': miss.status,
      'edge-miss-x-cache-miss': miss.xCache === 'MISS' ? 1 : 0,
      'edge-hit': hit.status,
      'cache-hit': hit.xCache === 'HIT' ? 1 : 0,
      'cache-control-immutable': hit.cacheControl === IMMUTABLE ? 1 : 0,
      'edge-head': head.status,
      'head-x-cache-hit': head.xCache === 'HIT' ? 1 : 0,
      'head-body-bytes': head.body.length,
      'head-content-length-match': head.contentLength === V1.length ? 1 : 0,
      revalidate: revalidate.status,
      'revalidate-body-bytes': revalidate.body.length,
      'no-cache-control-hit': plainAgain.xCache === 'HIT' ? 1 : 0,
      'new-name': v2.key !== v1.key ? 1 : 0,
      'new-url': fresh.status,
      'content-changed': fresh.body.equals(V2) && !fresh.body.equals(miss.body) ? 1 : 0,
      'old-url-still-hit': old.xCache === 'HIT' && old.body.equals(V1) ? 1 : 0,
      invalidations: 0,
      'origin-fetches': stats.originFetches,
    };
    return {
      lines,
      ok:
        lines.direct === 403 &&
        lines['edge-miss'] === 200 &&
        lines['edge-miss-x-cache-miss'] === 1 &&
        lines['edge-hit'] === 200 &&
        lines['cache-hit'] === 1 &&
        lines['cache-control-immutable'] === 1 &&
        lines['edge-head'] === 200 &&
        lines['head-x-cache-hit'] === 1 &&
        lines['head-body-bytes'] === 0 &&
        lines['head-content-length-match'] === 1 &&
        lines.revalidate === 304 &&
        lines['revalidate-body-bytes'] === 0 &&
        lines['no-cache-control-hit'] === 0 &&
        lines['new-name'] === 1 &&
        lines['new-url'] === 200 &&
        lines['content-changed'] === 1 &&
        lines['old-url-still-hit'] === 1 &&
        // v1, plain twice (never cached), v2: every other v1 read, HEAD and 304 came from the cache.
        lines['origin-fetches'] === 4,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function get(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  return {
    status: res.status,
    xCache: res.headers.get('x-cache'),
    cacheControl: res.headers.get('cache-control'),
    etag: res.headers.get('etag'),
    contentLength: Number(res.headers.get('content-length') ?? -1),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

main().catch(fail);
