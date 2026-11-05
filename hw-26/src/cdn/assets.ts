import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { Storage } from '../storage/storage';

/** Set on the object at upload: the edge (or CloudFront) caches only what the origin allows. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** app.css + content → app.15c42ab7.css. New content, new name: nothing to invalidate. */
export function hashedName(name: string, body: Buffer): string {
  const ext = extname(name);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return `${name.slice(0, name.length - ext.length)}.${hash}${ext}`;
}

export async function publishAsset(
  storage: Storage,
  name: string,
  body: Buffer,
): Promise<{ key: string; path: string }> {
  const key = `assets/${hashedName(name, body)}`;
  await storage.put(key, body, {
    contentType: TYPES[extname(name)] ?? 'application/octet-stream',
    cacheControl: IMMUTABLE,
  });
  return { key, path: `/${key}` };
}
