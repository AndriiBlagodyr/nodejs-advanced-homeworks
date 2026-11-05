import type { DataSource } from 'typeorm';
import type { SingleFlightCache, SingleFlightOptions } from '../redis/single-flight-cache';

/** Leading comment tags the query so a driver-level logger can count it. */
export const PRODUCT_CARD_SQL_TAG = '/* product-card */';

export const CARD_CACHE_OPTIONS: SingleFlightOptions = {
  ttlBaseSec: 300,
  ttlJitterSec: 60,
  negativeTtlBaseSec: 30,
  negativeTtlJitterSec: 15,
  lockTtlMs: 5000,
  pollMs: 25,
};

export type ProductCard = {
  id: number;
  name: string;
  price_cents: number;
  stock: number;
  is_active: boolean;
  units_sold: number;
  orders_count: number;
  revenue_cents: number;
  last_ordered_at: string | null;
};

export function cardKey(productId: number): string {
  return `product:card:${productId}`;
}

/** Product + sales aggregates over all order lines: the expensive read. */
export class ProductCardRepository {
  constructor(private readonly ds: DataSource) {}

  async load(productId: number): Promise<ProductCard | null> {
    const rows: Array<Record<string, unknown>> = await this.ds.query(
      `${PRODUCT_CARD_SQL_TAG}
       SELECT p.id, p.name, p.price_cents, p.stock, p.is_active,
              COALESCE(sum(oi.quantity) FILTER (WHERE o.status IN ('pending', 'completed')), 0)::int
                AS units_sold,
              count(DISTINCT oi.order_id) FILTER (WHERE o.status IN ('pending', 'completed'))::int
                AS orders_count,
              COALESCE(sum(oi.line_total_cents) FILTER (WHERE o.status IN ('pending', 'completed')), 0)::bigint
                AS revenue_cents,
              max(o.created_at) FILTER (WHERE o.status IN ('pending', 'completed'))
                AS last_ordered_at
         FROM products p
         LEFT JOIN order_items oi ON oi.product_id = p.id
         LEFT JOIN orders o ON o.id = oi.order_id
        WHERE p.id = $1
        GROUP BY p.id`,
      [productId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: Number(r.id),
      name: String(r.name),
      price_cents: Number(r.price_cents),
      stock: Number(r.stock),
      is_active: Boolean(r.is_active),
      units_sold: Number(r.units_sold),
      orders_count: Number(r.orders_count),
      revenue_cents: Number(r.revenue_cents),
      last_ordered_at: r.last_ordered_at ? new Date(r.last_ordered_at as string).toISOString() : null,
    };
  }
}

/**
 * Stock on the card may lag by up to one TTL. That is fine: checkout never
 * reads the card, it decrements stock atomically in Postgres.
 */
export class ProductCardService {
  constructor(
    private readonly repo: ProductCardRepository,
    private readonly cache: SingleFlightCache,
  ) {}

  get(productId: number): Promise<ProductCard | null> {
    return this.cache.getOrLoad(cardKey(productId), () => this.repo.load(productId));
  }
}
