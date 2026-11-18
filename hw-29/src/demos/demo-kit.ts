import type { Channel, ChannelModel, ConfirmChannel } from 'amqplib';
import type { Pool } from 'pg';
import { DataSource } from 'typeorm';
import { connectBroker } from '../broker/connection';
import { assertTopology, resetWorkQueues } from '../broker/topology';
import { createDataSourceOptions } from '../data-source';
import { CONSUMER_NAME, type ConsumerStats, startOrderPlacedConsumer } from '../outbox/consumer';
import { createPool } from '../outbox/pg';

export const DEMO_USER_ID = '9001';
export const DEMO_PRODUCT_ID = '9001';
export const DEMO_PRODUCT_PRICE_CENTS = 1500;

export type DemoCtx = {
  ds: DataSource;
  pool: Pool;
  relayCh: ConfirmChannel;
  stats: ConsumerStats;
};

export type Counts = {
  orders: number;
  outbox: number;
  outboxPublished: number;
  effect: number;
  processed: number;
};

/**
 * Brings DB and broker to a clean state, starts the consumer in this process
 * and hands the context to the demo. The relay channel is separate from the
 * consumer channel; the relay never declares topology.
 */
export async function withDemo<T>(fn: (ctx: DemoCtx) => Promise<T>): Promise<T> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();
  const pool = createPool();
  let conn: ChannelModel | undefined;
  try {
    await ds.runMigrations({ transaction: 'each' });
    await resetDb(ds);

    conn = await connectBroker();
    const adminCh: Channel = await conn.createChannel();
    await resetWorkQueues(adminCh);
    await assertTopology(adminCh);
    await adminCh.close();

    const consumeCh = await conn.createChannel();
    const relayCh = await conn.createConfirmChannel();
    const consumer = await startOrderPlacedConsumer(consumeCh, pool);
    try {
      return await fn({ ds, pool, relayCh, stats: consumer.stats });
    } finally {
      await consumer.stop().catch(() => undefined);
    }
  } finally {
    await conn?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await ds.destroy().catch(() => undefined);
  }
}

async function resetDb(ds: DataSource): Promise<void> {
  await ds.query(
    `INSERT INTO users (id, email, full_name, balance_cents)
     VALUES ($1, 'outbox-demo@example.com', 'Outbox Demo', 10000000)
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_USER_ID],
  );
  await ds.query(
    `INSERT INTO products (id, name, price_cents, stock, is_active)
     VALUES ($1, 'Outbox Demo Widget', $2, 1000, true)
     ON CONFLICT (id) DO UPDATE SET
       price_cents = EXCLUDED.price_cents, stock = EXCLUDED.stock, is_active = true`,
    [DEMO_PRODUCT_ID, DEMO_PRODUCT_PRICE_CENTS],
  );
  // idempotency_records and order_items go with the orders (ON DELETE CASCADE).
  await ds.query('DELETE FROM orders WHERE user_id = $1', [DEMO_USER_ID]);
  await ds.query('TRUNCATE TABLE outbox, processed_messages, order_confirmations');
}

export async function counts(pool: Pool): Promise<Counts> {
  const { rows } = await pool.query<Counts>(
    `SELECT
       (SELECT count(*)::int FROM orders WHERE user_id = $1)                   AS "orders",
       (SELECT count(*)::int FROM outbox)                                      AS "outbox",
       (SELECT count(*)::int FROM outbox WHERE published_at IS NOT NULL)       AS "outboxPublished",
       (SELECT count(*)::int FROM order_confirmations)                         AS "effect",
       (SELECT count(*)::int FROM processed_messages WHERE consumer = $2)      AS "processed"`,
    [DEMO_USER_ID, CONSUMER_NAME],
  );
  return rows[0];
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await sleep(20);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Prints key=value lines and exits non-zero when the invariant is broken. */
export function report(lines: Record<string, number>, ok: boolean): never {
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  console.log(`invariant-ok=${ok ? 1 : 0}`);
  process.exit(ok ? 0 : 1);
}

export function fail(err: unknown): never {
  console.error(err);
  process.exit(1);
}
