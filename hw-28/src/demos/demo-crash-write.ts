import { randomUUID } from 'node:crypto';
import { placeOrder } from '../orders/place-order';
import { drainOutbox } from '../outbox/relay';
import { counts, DEMO_PRODUCT_ID, DEMO_USER_ID, fail, report, sleep, withDemo } from './demo-kit';

/**
 * The business transaction fails AFTER the outbox row is inserted. Order and
 * outbox row must disappear together, so the relay has nothing to publish.
 */
async function main(): Promise<void> {
  const result = await withDemo(async ({ ds, pool, relayCh, stats }) => {
    const stockBefore = await productStock(pool);
    let outboxInTx = 0;
    let writeFailed = 0;

    try {
      await placeOrder(
        ds,
        {
          userId: DEMO_USER_ID,
          items: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }],
          idempotencyKey: `demo-crash-write-${randomUUID()}`,
        },
        {
          afterOutboxInsert: async (manager) => {
            const rows: Array<{ n: number }> = await manager.query(
              'SELECT count(*)::int AS n FROM outbox',
            );
            outboxInTx = rows[0].n;
            throw new Error('simulated crash after outbox insert');
          },
        },
      );
    } catch {
      writeFailed = 1;
    }

    const published = await drainOutbox(pool, relayCh);
    await sleep(1000);
    const stockUnchanged = (await productStock(pool)) === stockBefore ? 1 : 0;

    return { writeFailed, outboxInTx, published, stockUnchanged, stats: { ...stats }, c: await counts(pool) };
  });

  const { writeFailed, outboxInTx, published, stockUnchanged, stats, c } = result;
  report(
    {
      'write-failed': writeFailed,
      'outbox-in-tx': outboxInTx,
      orders: c.orders,
      outbox: c.outbox,
      published,
      deliveries: stats.deliveries,
      effect: c.effect,
      'stock-unchanged': stockUnchanged,
    },
    writeFailed === 1 &&
      outboxInTx === 1 &&
      c.orders === 0 &&
      c.outbox === 0 &&
      published === 0 &&
      stats.deliveries === 0 &&
      c.effect === 0 &&
      stockUnchanged === 1,
  );
}

async function productStock(pool: import('pg').Pool): Promise<number> {
  const { rows } = await pool.query<{ stock: number }>(
    'SELECT stock FROM products WHERE id = $1',
    [DEMO_PRODUCT_ID],
  );
  return rows[0].stock;
}

main().catch(fail);
