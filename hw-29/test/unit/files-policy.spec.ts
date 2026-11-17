import { cacheableSeconds } from '../../src/cdn/edge';
import { hashedName, IMMUTABLE } from '../../src/cdn/assets';
import {
  magicMatches,
  MAX_PART_BYTES,
  MAX_PARTS,
  MIN_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  multipartThreshold,
  partLength,
  planParts,
} from '../../src/files/policy';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('planParts', () => {
  it.each([12 * MiB, 48 * GiB, 50 * GiB, 1024 * GiB, 5 * 1024 * GiB])(
    'stays within S3 limits for %d bytes',
    (size) => {
      const { partSize, partCount } = planParts(size);
      expect(partCount).toBeLessThanOrEqual(MAX_PARTS);
      expect(partSize).toBeGreaterThanOrEqual(MIN_PART_BYTES);
      expect(partSize).toBeLessThanOrEqual(MAX_PART_BYTES);
      expect(partSize * partCount).toBeGreaterThanOrEqual(size);
      expect(partSize * (partCount - 1)).toBeLessThan(size);
    },
  );

  it('a fixed 5 MiB would need more than 10 000 parts at 50 GiB; the plan does not', () => {
    expect(Math.ceil((50 * GiB) / (5 * MiB))).toBeGreaterThan(MAX_PARTS);
    expect(planParts(50 * GiB).partSize).toBe(6 * MiB);
  });

  it('the demo file is three parts: 5 + 5 + 2 MiB', () => {
    const plan = planParts(12 * MiB);
    expect(plan).toEqual({ partSize: 5 * MiB, partCount: 3 });
    expect([1, 2, 3].map((n) => partLength(plan, 12 * MiB, n))).toEqual([5 * MiB, 5 * MiB, 2 * MiB]);
  });

  it('the threshold is computed from the retry budget and stays above the minimum part', () => {
    expect(MULTIPART_THRESHOLD_BYTES).toBe(8 * MiB);
    expect(multipartThreshold(120, 1024 * 1024)).toBe(120 * MiB);
    expect(multipartThreshold(1, 1024)).toBe(MIN_PART_BYTES + MiB);
    expect(MULTIPART_THRESHOLD_BYTES).toBeGreaterThan(MIN_PART_BYTES);
  });
});

describe('magic bytes', () => {
  it('accepts a real PNG header and rejects text sent as image/png', () => {
    expect(magicMatches('image/png', Buffer.from('89504e470d0a1a0a00', 'hex'))).toBe(true);
    expect(magicMatches('image/png', Buffer.from('<?php echo 1; ?>'))).toBe(false);
  });
});

describe('edge caching rules', () => {
  it.each([
    [IMMUTABLE, 31536000],
    ['public, s-maxage=60, max-age=10', 60],
    ['private, max-age=600', 0],
    ['public, no-store, max-age=600', 0],
    ['max-age=600', 0],
    [undefined, 0],
  ])('%s → %d s', (header, ttl) => {
    expect(cacheableSeconds(header)).toBe(ttl);
  });

  it('content-hashed names change with content and only with content', () => {
    const a = hashedName('app.css', Buffer.from('a'));
    expect(a).toMatch(/^app\.[0-9a-f]{8}\.css$/);
    expect(hashedName('app.css', Buffer.from('a'))).toBe(a);
    expect(hashedName('app.css', Buffer.from('b'))).not.toBe(a);
  });
});
