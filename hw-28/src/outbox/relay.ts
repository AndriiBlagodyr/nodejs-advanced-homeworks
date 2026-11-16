import type { ConfirmChannel } from 'amqplib';
import type { Pool } from 'pg';
import { EXCHANGE_EVENTS } from '../broker/constants';
import { errorMessage } from './errors';

export const RELAY_BATCH_SIZE = 50;
export const RELAY_POLL_MS = 500;
/** A row that failed this many publishes is parked: no longer selected by the relay. */
export const RELAY_MAX_ATTEMPTS = 5;

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

export type RelayResult = { published: number; failed: number };

/**
 * One relay pass: claim → publish → mark, in exactly this order.
 * Marking first would turn a failed publish into a lost event; publishing
 * first turns a crash before the UPDATE into a duplicate, which the consumer
 * dedups.
 *
 * Each row is confirmed separately. A row the broker refused gets
 * attempts + 1 and last_error; once attempts reach RELAY_MAX_ATTEMPTS it is
 * parked. A closed channel or a DB error is infrastructure, not the row's
 * fault: the transaction rolls back, attempts stay as they are, and the error
 * is rethrown.
 */
export async function relayBatch(
  pool: Pool,
  ch: ConfirmChannel,
  opts: RelayOptions = {},
): Promise<RelayResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, aggregate_type, aggregate_id, type, payload
         FROM outbox
        WHERE published_at IS NULL AND attempts < $2
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [opts.batchSize ?? RELAY_BATCH_SIZE, RELAY_MAX_ATTEMPTS],
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { published: 0, failed: 0 };
    }

    const confirms: Array<Promise<void>> = [];
    for (const row of rows) {
      confirms.push((await publishRow(ch, row)).confirmed);
    }
    const settled = await Promise.allSettled(confirms);

    const confirmedRows: OutboxRow[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        confirmedRows.push(rows[i]);
      } else {
        if (isChannelClosed(s.reason)) throw s.reason;
        failed.push({ id: rows[i].id, error: errorMessage(s.reason) });
      }
    });

    await opts.afterPublish?.(confirmedRows);

    if (confirmedRows.length > 0) {
      await client.query(
        `UPDATE outbox
            SET published_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = ANY($1::uuid[])`,
        [confirmedRows.map((r) => r.id)],
      );
    }
    for (const f of failed) {
      await client.query(
        `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
        [f.id, f.error],
      );
    }
    await client.query('COMMIT');
    return { published: confirmedRows.length, failed: failed.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Sends one row (respecting backpressure) and hands back its broker confirm. */
async function publishRow(
  ch: ConfirmChannel,
  row: OutboxRow,
): Promise<{ confirmed: Promise<void> }> {
  let content: Buffer;
  try {
    content = Buffer.from(JSON.stringify(row.payload));
  } catch (err) {
    return { confirmed: Promise.reject(err) };
  }
  let sent = true;
  const confirmed = new Promise<void>((resolve, reject) => {
    sent = ch.publish(
      EXCHANGE_EVENTS,
      row.type,
      content,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: row.id,
        type: row.type,
        headers: { 'aggregate-type': row.aggregate_type, 'aggregate-id': row.aggregate_id },
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  // Avoid an unhandled rejection while later rows are still being sent.
  confirmed.catch(() => undefined);
  if (!sent) {
    await new Promise<void>((resolve) => ch.once('drain', resolve));
  }
  return { confirmed };
}

function isChannelClosed(err: unknown): boolean {
  return /channel closed|channel ended|connection closed/i.test(errorMessage(err));
}

/** Rows the relay will still try to publish (parked rows excluded). */
export async function countPending(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL AND attempts < $1',
    [RELAY_MAX_ATTEMPTS],
  );
  return rows[0].n;
}

/** Rows that exhausted RELAY_MAX_ATTEMPTS and wait for a human. */
export async function countParked(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL AND attempts >= $1',
    [RELAY_MAX_ATTEMPTS],
  );
  return rows[0].n;
}

/**
 * Relays until nothing pending is left. Rows still locked by a dead relay are
 * skipped by SKIP LOCKED, so this keeps polling until Postgres releases them.
 * A poison row stops being pending after RELAY_MAX_ATTEMPTS, so it cannot
 * keep the loop busy until the timeout.
 */
export async function drainOutbox(
  pool: Pool,
  ch: ConfirmChannel,
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let published = 0;
  for (;;) {
    published += (await relayBatch(pool, ch)).published;
    if ((await countPending(pool)) === 0) return published;
    if (Date.now() > deadline) {
      throw new Error('relay timeout: outbox still has pending rows');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
