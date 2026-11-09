import type { AddressInfo } from 'node:net';
import { createEdge, etagMatches } from '../../src/cdn/edge';
import { IMMUTABLE } from '../../src/cdn/assets';
import type { Storage, StoredObject } from '../../src/storage/storage';

const KiB = 1024;

function fakeStorage(objects: Record<string, StoredObject>) {
  const fetched: string[] = [];
  const storage = {
    get: async (key: string) => {
      fetched.push(key);
      return objects[key] ?? null;
    },
  } as unknown as Storage;
  return { storage, fetched };
}

function asset(bytes: number, etag: string): StoredObject {
  return { body: Buffer.alloc(bytes, 1), contentType: 'text/css', cacheControl: IMMUTABLE, etag };
}

async function withEdge(
  objects: Record<string, StoredObject>,
  opts: Parameters<typeof createEdge>[1],
  fn: (base: string, edge: ReturnType<typeof createEdge>, fetched: string[]) => Promise<void>,
) {
  const { storage, fetched } = fakeStorage(objects);
  const edge = createEdge(storage, opts);
  await new Promise<void>((r) => edge.server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(edge.server.address() as AddressInfo).port}`, edge, fetched);
  } finally {
    edge.server.closeAllConnections();
    await new Promise<void>((r) => edge.server.close(() => r()));
  }
}

describe('edge cache', () => {
  it('bounds the cache by bytes, evicting the least recently used', async () => {
    const objects = {
      'assets/a.css': asset(40 * KiB, '"a"'),
      'assets/b.css': asset(40 * KiB, '"b"'),
      'assets/c.css': asset(40 * KiB, '"c"'),
    };
    await withEdge(objects, { maxBytes: 100 * KiB }, async (base, { stats }) => {
      await fetch(`${base}/assets/a.css`).then((r) => r.arrayBuffer());
      await fetch(`${base}/assets/b.css`).then((r) => r.arrayBuffer());
      await fetch(`${base}/assets/a.css`).then((r) => r.arrayBuffer()); // a is now most recent
      await fetch(`${base}/assets/c.css`).then((r) => r.arrayBuffer()); // 120 KiB > 100: b goes

      expect(stats.cachedBytes).toBe(80 * KiB);
      expect(stats.evictions).toBe(1);
      expect((await fetch(`${base}/assets/a.css`)).headers.get('x-cache')).toBe('HIT');
      expect((await fetch(`${base}/assets/b.css`)).headers.get('x-cache')).toBe('MISS');
    });
  });

  it('serves but does not cache an object above the per-object limit', async () => {
    const objects = { 'assets/big.bin': asset(64 * KiB, '"big"') };
    await withEdge(objects, { maxBytes: 1024 * KiB, maxObjectBytes: 32 * KiB }, async (base, { stats }) => {
      expect((await fetch(`${base}/assets/big.bin`)).status).toBe(200);
      expect((await fetch(`${base}/assets/big.bin`)).headers.get('x-cache')).toBe('MISS');
      expect(stats.cachedBytes).toBe(0);
    });
  });

  it('answers HEAD from the cache with headers and no body', async () => {
    const objects = { 'assets/a.css': asset(3 * KiB, '"a"') };
    await withEdge(objects, {}, async (base, _edge, fetched) => {
      const miss = await fetch(`${base}/assets/a.css`, { method: 'HEAD' });
      const hit = await fetch(`${base}/assets/a.css`, { method: 'HEAD' });
      expect(miss.status).toBe(200);
      expect(hit.headers.get('x-cache')).toBe('HIT');
      expect(hit.headers.get('content-length')).toBe(String(3 * KiB));
      expect(hit.headers.get('cache-control')).toBe(IMMUTABLE);
      expect((await hit.arrayBuffer()).byteLength).toBe(0);
      expect(fetched).toEqual(['assets/a.css']);
    });
  });

  it('answers 304 to a matching If-None-Match and 200 otherwise', async () => {
    const objects = { 'assets/a.css': asset(KiB, '"abc"') };
    await withEdge(objects, {}, async (base) => {
      const match = await fetch(`${base}/assets/a.css`, { headers: { 'if-none-match': 'W/"abc"' } });
      expect(match.status).toBe(304);
      expect(match.headers.get('etag')).toBe('"abc"');
      const other = await fetch(`${base}/assets/a.css`, { headers: { 'if-none-match': '"zzz"' } });
      expect(other.status).toBe(200);
    });
  });

  it('refuses other methods with 405', async () => {
    await withEdge({}, {}, async (base) => {
      const res = await fetch(`${base}/assets/a.css`, { method: 'POST' });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    });
  });

  it('compares ETags weakly', () => {
    expect(etagMatches('"x"', '"x"')).toBe(true);
    expect(etagMatches('W/"x"', '"x"')).toBe(true);
    expect(etagMatches('"a", "x"', '"x"')).toBe(true);
    expect(etagMatches('*', '"x"')).toBe(true);
    expect(etagMatches('"y"', '"x"')).toBe(false);
    expect(etagMatches(undefined, '"x"')).toBe(false);
  });
});
