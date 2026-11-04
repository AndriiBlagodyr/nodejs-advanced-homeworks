const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * contentType → extension and size cap. The extension of the object key comes
 * from here, never from the client's filename.
 */
export const ALLOWED_TYPES: Record<string, { ext: string; maxBytes: number }> = {
  'image/png': { ext: 'png', maxBytes: 20 * MiB },
  'image/jpeg': { ext: 'jpg', maxBytes: 20 * MiB },
  'image/webp': { ext: 'webp', maxBytes: 20 * MiB },
  'application/pdf': { ext: 'pdf', maxBytes: 100 * MiB },
  // pg_dump archives from HW-15.
  'application/gzip': { ext: 'gz', maxBytes: 1024 * GiB },
};

/**
 * Single PUT URL: a photo/avatar form uploads right after intent, so 5 minutes
 * covers a slow mobile link with room to spare. It cannot be revoked, so it is
 * short.
 */
export const PUT_URL_TTL_SEC = 5 * 60;
/** Per-part URL: one part, not the whole file. A resume asks for fresh ones. */
export const PART_URL_TTL_SEC = 15 * 60;
/** GET /files/:id → 302: the client follows it at once. */
export const DOWNLOAD_URL_TTL_SEC = 60;

/** S3 limits: at most 10 000 parts, each 5 MiB … 5 GiB except the last. */
export const MAX_PARTS = 10_000;
export const MIN_PART_BYTES = 5 * MiB;
export const MAX_PART_BYTES = 5 * GiB;
export const MAX_OBJECT_BYTES = 5 * 1024 * GiB;
/**
 * What a dropped single PUT may cost to redo from zero, on the slowest link
 * we design for (1 Mbit/s mobile uplink ≈ 128 KiB/s). Above the resulting
 * size a single PUT is replaced by a resumable multipart upload.
 */
export const RETRY_BUDGET_SEC = 64;
export const SLOW_LINK_BYTES_PER_SEC = 128 * 1024;

export function multipartThreshold(
  budgetSec = RETRY_BUDGET_SEC,
  bytesPerSec = SLOW_LINK_BYTES_PER_SEC,
): number {
  const bySpeed = Math.ceil((budgetSec * bytesPerSec) / MiB) * MiB;
  // Below two minimum parts multipart would be one part plus a stub: no resume gained.
  return Math.max(bySpeed, MIN_PART_BYTES + MiB);
}

/** 64 s × 128 KiB/s = 8 MiB, which is also the AWS CLI default multipart_threshold. */
export const MULTIPART_THRESHOLD_BYTES = multipartThreshold();

export type PartPlan = { partSize: number; partCount: number };

/**
 * partSize ≥ size / 10 000 (rounded up to a whole MiB), and never below the
 * 5 MiB minimum. A fixed 5 MiB fails on anything above ~48.8 GiB.
 */
export function planParts(size: number): PartPlan {
  if (size > MAX_OBJECT_BYTES) throw new Error('object too large for S3');
  const byCount = Math.ceil(Math.ceil(size / MAX_PARTS) / MiB) * MiB;
  const partSize = Math.max(MIN_PART_BYTES, byCount);
  if (partSize > MAX_PART_BYTES) throw new Error('part size above the S3 maximum');
  return { partSize, partCount: Math.ceil(size / partSize) };
}

export function partLength(plan: PartPlan, size: number, partNumber: number): number {
  return partNumber < plan.partCount ? plan.partSize : size - plan.partSize * (plan.partCount - 1);
}

/** Content-Type is the client's word. The first bytes are the file's. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'application/gzip': (b) => b[0] === 0x1f && b[1] === 0x8b,
};

export const MAGIC_BYTES = 16;

export function magicMatches(contentType: string, head: Buffer): boolean {
  return MAGIC[contentType]?.(head) ?? false;
}
