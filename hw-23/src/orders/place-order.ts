import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { returningRows } from '../db-result';
import {
  ORDER_AGGREGATE,
  ORDER_PLACED,
  type PlacedOrder,
  toOrderPlacedEvent,
} from '../outbox/order-placed.event';

export type PlaceOrderInput = {
  userId: string;
  items: Array<{ productId: string; quantity: number }>;
  shippingCountry?: string;
  idempotencyKey?: string;
};

export type OrderResponseBody = {
  id: number;
  items: Array<{
    product_id: number;
    quantity: number;
    unit_price_cents: number;
    line_total_cents: number;
  }>;
  total_cents: number;
  created_at: string;
};

export type PlaceOrderResult = {
  status: number;
  body: OrderResponseBody;
  replayed: boolean;
};

export type PlaceOrderHooks = {
  /** Runs inside the transaction right after the outbox row is inserted. */
  afterOutboxInsert?: (manager: EntityManager) => Promise<void>;
};

class IdempotentReplay extends Error {}

/**
 * Order rows, the Idempotency-Key claim and the outbox row commit in ONE
 * transaction. Nothing is published here: the broker cannot roll back.
 */
export async function placeOrder(
  ds: DataSource,
  input: PlaceOrderInput,
  hooks: PlaceOrderHooks = {},
): Promise<PlaceOrderResult> {
  const key = input.idempotencyKey;
  const requestHash = hashRequest(input);

  if (key) {
    const prior = await findReplay(ds.manager, key, requestHash);
    if (prior) return prior;
  }

  try {
    return await ds.transaction(async (manager) => {
      const order = await insertOrder(manager, input);
      const body = toResponseBody(order);

      if (key) {
        const claimed = returningRows<{ idempotency_key: string }>(
          await manager.query(
            `INSERT INTO idempotency_records
               (idempotency_key, order_id, request_hash, response_status, response_body)
             VALUES ($1, $2, $3, 201, $4::jsonb)
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING idempotency_key`,
            [key, order.orderId, requestHash, JSON.stringify(body)],
          ),
        );
        if (claimed.length === 0) throw new IdempotentReplay();
      }

      const eventId = randomUUID();
      await manager.query(
        `INSERT INTO outbox (id, aggregate_type, aggregate_id, type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          eventId,
          ORDER_AGGREGATE,
          order.orderId,
          ORDER_PLACED,
          JSON.stringify(toOrderPlacedEvent(eventId, order)),
        ],
      );
      await hooks.afterOutboxInsert?.(manager);

      return { status: 201, body, replayed: false };
    });
  } catch (err) {
    if (err instanceof IdempotentReplay && key) {
      const prior = await findReplay(ds.manager, key, requestHash);
      if (prior) return prior;
    }
    throw err;
  }
}

/**
 * The key identifies the intent; the hash only guards against reusing one
 * key for a different request. Two identical orders with different keys are
 * two orders.
 */
function hashRequest(input: PlaceOrderInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        userId: input.userId,
        shippingCountry: input.shippingCountry ?? 'US',
        items: input.items.map((i) => [String(i.productId), i.quantity]),
      }),
    )
    .digest('hex');
}

async function findReplay(
  manager: EntityManager,
  key: string,
  requestHash: string,
): Promise<PlaceOrderResult | null> {
  const rows: Array<{
    request_hash: string;
    response_status: number;
    response_body: OrderResponseBody;
  }> = await manager.query(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_records
      WHERE idempotency_key = $1`,
    [key],
  );
  if (rows.length === 0) return null;
  if (rows[0].request_hash !== requestHash) {
    throw new UnprocessableEntityException(
      'Idempotency-Key was already used with a different request',
    );
  }
  return { status: rows[0].response_status, body: rows[0].response_body, replayed: true };
}

async function insertOrder(manager: EntityManager, input: PlaceOrderInput): Promise<PlacedOrder> {
  const shippingCountry = input.shippingCountry ?? 'US';
  // Stable lock order across concurrent orders touching the same products.
  const items = [...input.items].sort((a, b) => Number(a.productId) - Number(b.productId));

  const lines: PlacedOrder['items'] = [];
  for (const item of items) {
    const rows = returningRows<{ price_cents: number | string }>(
      await manager.query(
        `UPDATE products
            SET stock = stock - $1
          WHERE id = $2 AND is_active = true AND stock >= $1
          RETURNING price_cents`,
        [item.quantity, item.productId],
      ),
    );
    if (rows.length === 0) {
      const exists: unknown[] = await manager.query(
        'SELECT 1 FROM products WHERE id = $1 AND is_active = true',
        [item.productId],
      );
      if (exists.length === 0) {
        throw new NotFoundException(`Product ${item.productId} not found`);
      }
      throw new BadRequestException(`Insufficient stock for product ${item.productId}`);
    }
    const unitPriceCents = Number(rows[0].price_cents);
    lines.push({
      productId: String(item.productId),
      quantity: item.quantity,
      unitPriceCents,
      lineTotalCents: unitPriceCents * item.quantity,
    });
  }

  const totalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const orderRows = returningRows<{ id: string; created_at: Date }>(
    await manager.query(
      `INSERT INTO orders (user_id, status, total_cents, shipping_country)
       VALUES ($1, 'completed', $2, $3)
       RETURNING id, created_at`,
      [input.userId, totalCents, shippingCountry],
    ),
  );
  const orderId = String(orderRows[0].id);

  for (const l of lines) {
    await manager.query(
      `INSERT INTO order_items
         (order_id, product_id, quantity, unit_price_cents, line_total_cents)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, l.productId, l.quantity, l.unitPriceCents, l.lineTotalCents],
    );
  }

  return {
    orderId,
    userId: String(input.userId),
    totalCents,
    shippingCountry,
    createdAt: new Date(orderRows[0].created_at),
    items: lines,
  };
}

function toResponseBody(order: PlacedOrder): OrderResponseBody {
  return {
    id: Number(order.orderId),
    items: order.items.map((i) => ({
      product_id: Number(i.productId),
      quantity: i.quantity,
      unit_price_cents: i.unitPriceCents,
      line_total_cents: i.lineTotalCents,
    })),
    total_cents: order.totalCents,
    created_at: order.createdAt.toISOString(),
  };
}
