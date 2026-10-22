import { DataSource } from 'typeorm';
import { checkout, InsufficientStockError } from './checkout';
import { createDataSourceOptions } from './data-source';
import { returningRows } from './db-result';

const ATTEMPTS = 50;
const INITIAL_STOCK = 10;
const QTY = 1;

type IdRow = { id: string };

async function prepare(ds: DataSource): Promise<string> {
  // Insert a fresh race product without a fixed id so we never collide with seed data.
  const productRows = returningRows<IdRow>(
    await ds.query(
      `INSERT INTO products (name, price_cents, stock, is_active)
       VALUES ('Race Widget', 100, $1, true)
       RETURNING id`,
      [INITIAL_STOCK],
    ),
  );
  const raceProductId = String(productRows[0].id);

  // Buyers with deliberately oversized balances — stock is the only limit.
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    await ds.query(
      `INSERT INTO users (id, email, full_name, balance_cents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         balance_cents = EXCLUDED.balance_cents`,
      [
        String(1000 + i),
        `race-buyer-${i}@example.com`,
        `Race Buyer ${i}`,
        10_000_000,
      ],
    );
  }

  await ds.query(
    `SELECT setval(pg_get_serial_sequence('users', 'id'),
            COALESCE((SELECT MAX(id) FROM users), 1))`,
  );

  return raceProductId;
}

async function main(): Promise<void> {
  const ds = new DataSource(
    createDataSourceOptions({
      extra: { max: 60 },
    }),
  );
  await ds.initialize();

  try {
    const raceProductId = await prepare(ds);

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, index) =>
        ds
          .transaction((manager) =>
            checkout(manager, {
              userId: String(1000 + index + 1),
              productId: raceProductId,
              quantity: QTY,
            }),
          )
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => {
            if (error instanceof InsufficientStockError) {
              return { ok: false as const, reason: 'stock' };
            }
            throw error;
          }),
      ),
    );

    const successes = results.filter((r) => r.ok).length;
    const stockRows: Array<{ stock: number }> = await ds.query(
      `SELECT stock FROM products WHERE id = $1`,
      [raceProductId],
    );
    const finalStock = Number(stockRows[0]?.stock);
    const negativeRows: Array<{ count: string }> = await ds.query(
      `SELECT count(*)::text AS count FROM products WHERE stock < 0`,
    );
    const negativeStockRows = Number(negativeRows[0].count);

    console.log('demo:race');
    console.log(`attempts: ${ATTEMPTS}`);
    console.log(`successes: ${successes}`);
    console.log(`final stock: ${finalStock}`);
    console.log(`negative stock rows: ${negativeStockRows}`);

    const ok =
      ATTEMPTS >= 50 &&
      successes === INITIAL_STOCK &&
      finalStock === 0 &&
      negativeStockRows === 0;

    if (!ok) {
      console.error('invariant failed: oversell or unexpected race result');
      process.exit(1);
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
