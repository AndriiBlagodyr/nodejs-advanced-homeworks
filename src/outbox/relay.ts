import type { ConfirmChannel } from 'amqplib';
import type { Pool } from 'pg';
import { EXCHANGE_EVENTS } from '../broker/constants';

export const RELAY_BATCH_SIZE = 50;
export const RELAY_POLL_MS = 500;

export type OutboxRow = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  type: string;
  payload: unknown;
};

export type RelayOptions = {
  batchSize?: number;
  /** Runs after the broker confirmed the batch and before published_at is written. */
  afterPublish?: (rows: OutboxRow[]) => void | Promise<void>;
};

/**
 * One relay pass: claim → publish → mark, in exactly this order.
 * Marking first would turn a failed publish into a lost event; publishing
 * first turns a crash before the UPDATE into a duplicate, which the consumer
 * dedups.
 */
export async function relayBatch(
  pool: Pool,
  ch: ConfirmChannel,
  opts: RelayOptions = {},
): Promise<number> {
  const client = await pool.connect();
  let ids: string[] = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, aggregate_type, aggregate_id, type, payload
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [opts.batchSize ?? RELAY_BATCH_SIZE],
    );
    ids = rows.map((r) => r.id);
    if (rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    for (const row of rows) {
      await publishRow(ch, row);
    }
    await ch.waitForConfirms();
    await opts.afterPublish?.(rows);

    await client.query(
      `UPDATE outbox
          SET published_at = now(), attempts = attempts + 1
        WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (ids.length > 0) {
      await pool
        .query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])`, [ids])
        .catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function publishRow(ch: ConfirmChannel, row: OutboxRow): Promise<void> {
  const ok = ch.publish(EXCHANGE_EVENTS, row.type, Buffer.from(JSON.stringify(row.payload)), {
    persistent: true,
    contentType: 'application/json',
    messageId: row.id,
    type: row.type,
    headers: { 'aggregate-type': row.aggregate_type, 'aggregate-id': row.aggregate_id },
  });
  if (!ok) {
    await new Promise<void>((resolve) => ch.once('drain', resolve));
  }
}

export async function countUnpublished(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL',
  );
  return rows[0].n;
}

/**
 * Relays until nothing is left unpublished. Rows still locked by a dead relay
 * are skipped by SKIP LOCKED, so this keeps polling until Postgres releases them.
 */
export async function drainOutbox(
  pool: Pool,
  ch: ConfirmChannel,
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let published = 0;
  for (;;) {
    published += await relayBatch(pool, ch);
    if ((await countUnpublished(pool)) === 0) return published;
    if (Date.now() > deadline) {
      throw new Error('relay timeout: outbox still has unpublished rows');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
