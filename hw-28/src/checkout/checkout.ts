import type { EntityManager } from 'typeorm';
import { returningRows } from '../db-result';
import {
  CheckoutInput,
  CheckoutResult,
  InsufficientFundsError,
  InsufficientStockError,
} from './errors';

type ProductRow = {
  id: string;
  price_cents: number | string;
  stock: number | string;
};

type IdRow = { id: string };

/**
 * Place an order in one transaction:
 * atomic stock decrement → balance debit → order + item → post-processing job.
 */
export async function checkout(
  manager: EntityManager,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const quantity = input.quantity;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`quantity must be a positive integer, got ${quantity}`);
  }

  const stockRows = returningRows<ProductRow>(
    await manager.query(
      `UPDATE products
          SET stock = stock - $1
        WHERE id = $2
          AND is_active = true
          AND stock >= $1
        RETURNING id, price_cents, stock`,
      [quantity, input.productId],
    ),
  );

  if (stockRows.length === 0) {
    throw new InsufficientStockError();
  }

  const unitPriceCents = Number(stockRows[0].price_cents);
  const totalCents = unitPriceCents * quantity;

  const balanceRows = returningRows<IdRow>(
    await manager.query(
      `UPDATE users
          SET balance_cents = balance_cents - $1
        WHERE id = $2
          AND balance_cents >= $1
        RETURNING id`,
      [totalCents, input.userId],
    ),
  );

  if (balanceRows.length === 0) {
    throw new InsufficientFundsError();
  }

  const shippingCountry = input.shippingCountry ?? 'US';

  const orderRows = returningRows<IdRow>(
    await manager.query(
      `INSERT INTO orders (user_id, status, total_cents, shipping_country)
       VALUES ($1, 'completed', $2, $3)
       RETURNING id`,
      [input.userId, totalCents, shippingCountry],
    ),
  );
  const orderId = String(orderRows[0].id);

  await manager.query(
    `INSERT INTO order_items
       (order_id, product_id, quantity, unit_price_cents, line_total_cents)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, input.productId, quantity, unitPriceCents, totalCents],
  );

  const jobRows = returningRows<IdRow>(
    await manager.query(
      `INSERT INTO jobs (type, payload, status, order_id)
       VALUES (
         'send_receipt',
         $1::jsonb,
         'pending',
         $2
       )
       RETURNING id`,
      [JSON.stringify({ orderId, userId: input.userId }), orderId],
    ),
  );

  return {
    orderId,
    jobId: String(jobRows[0].id),
    totalCents,
    stockLeft: Number(stockRows[0].stock),
  };
}
