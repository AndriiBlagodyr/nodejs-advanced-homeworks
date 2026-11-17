import type { Pool } from 'pg';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Published outbox rows are kept this long for debugging/replay, then deleted. */
export const OUTBOX_RETENTION_MS = 7 * DAY_MS;
/**
 * Inbox marks must outlive any redelivery of the same message; 30 days is far
 * beyond outbox retention, so a message cannot come back after its mark is gone.
 */
export const INBOX_RETENTION_MS = 30 * DAY_MS;
export const PURGE_BATCH_SIZE = 1000;
export const PURGE_INTERVAL_MS = 10 * 60 * 1000;

export type PurgeOptions = {
  outboxRetentionMs?: number;
  inboxRetentionMs?: number;
  batchSize?: number;
};

export type PurgeResult = { outbox: number; processed: number };

/**
 * Deletes in small batches so a big backlog never holds long locks or bloats
 * one transaction. Only published rows are eligible; pending and parked rows
 * (published_at IS NULL) are never touched.
 */
export async function purgeOutbox(pool: Pool, opts: PurgeOptions = {}): Promise<PurgeResult> {
  const batch = opts.batchSize ?? PURGE_BATCH_SIZE;
  const outboxCutoff = new Date(Date.now() - (opts.outboxRetentionMs ?? OUTBOX_RETENTION_MS));
  const inboxCutoff = new Date(Date.now() - (opts.inboxRetentionMs ?? INBOX_RETENTION_MS));

  const outbox = await deleteInBatches(
    pool,
    `DELETE FROM outbox
      WHERE id IN (
        SELECT id FROM outbox
         WHERE published_at IS NOT NULL AND published_at < $1
         LIMIT $2
      )`,
    outboxCutoff,
    batch,
  );
  const processed = await deleteInBatches(
    pool,
    `DELETE FROM processed_messages
      WHERE (message_id, consumer) IN (
        SELECT message_id, consumer FROM processed_messages
         WHERE processed_at < $1
         LIMIT $2
      )`,
    inboxCutoff,
    batch,
  );
  return { outbox, processed };
}

async function deleteInBatches(
  pool: Pool,
  sql: string,
  cutoff: Date,
  batch: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await pool.query(sql, [cutoff, batch]);
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batch) return total;
  }
}
