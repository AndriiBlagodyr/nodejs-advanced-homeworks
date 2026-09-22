import { DataSource } from 'typeorm';
import { setupTestDb, teardownTestDb, truncateAll } from '../testkit/container';
import { aUser, aProduct, anOrder, anOrderItem, resetSeq } from '../testkit/builders';

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

describe('Orders repository', () => {
  it('creates an order with FK to user', async () => {
    const user = await aUser(ds);
    const order = await anOrder(ds, { user_id: user.id, total_cents: 500 });
    const [row] = await ds.query('SELECT * FROM orders WHERE id = $1', [order.id]);
    expect(row.user_id).toBe(user.id);
    expect(row.total_cents).toBe(500);
  });

  it('rejects order with non-existent user (foreign key constraint)', async () => {
    await expect(
      ds.query(
        `INSERT INTO orders (user_id, status, total_cents, shipping_country)
         VALUES (999999, 'pending', 0, 'US')`,
      ),
    ).rejects.toThrow(/foreign key|constraint|violates/i);
  });

  it('enforces unique (order_id, product_id) on order_items (duplicate key)', async () => {
    const user = await aUser(ds);
    const product = await aProduct(ds);
    const order = await anOrder(ds, { user_id: user.id });
    await anOrderItem(ds, {
      order_id: order.id,
      product_id: product.id,
      quantity: 1,
      unit_price_cents: 1000,
      line_total_cents: 1000,
    });
    await expect(
      anOrderItem(ds, {
        order_id: order.id,
        product_id: product.id,
        quantity: 2,
        unit_price_cents: 1000,
        line_total_cents: 2000,
      }),
    ).rejects.toThrow(/duplicate key|unique|23505/i);
  });

  it('cascades delete of order_items when order is deleted', async () => {
    const user = await aUser(ds);
    const product = await aProduct(ds);
    const order = await anOrder(ds, { user_id: user.id });
    await anOrderItem(ds, {
      order_id: order.id,
      product_id: product.id,
    });
    await ds.query('DELETE FROM orders WHERE id = $1', [order.id]);
    const items = await ds.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    expect(items).toHaveLength(0);
  });
});
