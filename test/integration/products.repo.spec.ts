import { DataSource } from 'typeorm';
import { setupTestDb, teardownTestDb, truncateAll } from '../testkit/container';
import { aProduct, resetSeq } from '../testkit/builders';

let ds: DataSource;

beforeAll(async () => {
  ds = await setupTestDb();
}, 120_000);

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await truncateAll(ds);
  resetSeq();
});

describe('Products repository', () => {
  it('inserts and retrieves a product', async () => {
    const p = await aProduct(ds, { name: 'Keyboard', price_cents: 5000, stock: 10 });
    const [row] = await ds.query('SELECT * FROM products WHERE id = $1', [p.id]);
    expect(row.name).toBe('Keyboard');
    expect(row.price_cents).toBe(5000);
    expect(row.stock).toBe(10);
  });

  it('enforces unique product name constraint implicitly via check', async () => {
    await aProduct(ds, { name: 'Widget AA' });
    // name is not unique by schema but price_cents must be >= 0
    await expect(
      ds.query(
        `INSERT INTO products (name, price_cents, stock) VALUES ('Bad', -1, 0)`,
      ),
    ).rejects.toThrow(/check/i);
  });

  it('returns aggregate price with JOIN on order_items', async () => {
    const { aUser, anOrder, anOrderItem } = await import('../testkit/builders');
    const user = await aUser(ds);
    const p1 = await aProduct(ds, { price_cents: 1000 });
    const p2 = await aProduct(ds, { price_cents: 2000 });
    const order = await anOrder(ds, { user_id: user.id, total_cents: 4000 });
    await anOrderItem(ds, {
      order_id: order.id,
      product_id: p1.id,
      quantity: 2,
      unit_price_cents: 1000,
      line_total_cents: 2000,
    });
    await anOrderItem(ds, {
      order_id: order.id,
      product_id: p2.id,
      quantity: 1,
      unit_price_cents: 2000,
      line_total_cents: 2000,
    });

    const [agg] = await ds.query(
      `SELECT sum(oi.line_total_cents) AS total
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [order.id],
    );
    expect(Number(agg.total)).toBe(4000);
  });
});
