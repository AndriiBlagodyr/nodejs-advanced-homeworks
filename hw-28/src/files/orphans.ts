import type { Pool } from 'pg';
import type { Storage } from '../storage/storage';

export const ORPHAN_AGE_HOURS = 24;
export const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const BATCH = 100;

/**
 * An intent that was never committed: a PENDING row and maybe an object or
 * billed-but-invisible multipart parts. Storage first, row last: if the
 * process dies in between, the row is still there and the next sweep retries.
 * SKIP LOCKED lets two workers share the work.
 */
export async function sweepOrphanFiles(
  pool: Pool,
  storage: Storage,
  olderThanHours = ORPHAN_AGE_HOURS,
): Promise<{ swept: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; key: string; upload_id: string | null }>(
      `SELECT id, key, upload_id FROM files
        WHERE status = 'PENDING' AND created_at < now() - make_interval(hours => $1)
        ORDER BY created_at
        LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`,
      [olderThanHours],
    );
    for (const row of rows) {
      if (row.upload_id) await storage.abortMultipart(row.key, row.upload_id);
      await storage.deleteObject(row.key);
    }
    if (rows.length > 0) {
      await client.query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    }
    await client.query('COMMIT');
    return { swept: rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
