import { DataSource } from 'typeorm';

let seq = 0;
function nextSeq(): number {
  return ++seq;
}

export function resetSeq(): void {
  seq = 0;
}

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  balance_cents: number;
}

export async function aUser(
  ds: DataSource,
  overrides: Partial<UserRow> = {},
): Promise<UserRow> {
  const n = nextSeq();
  const defaults: Omit<UserRow, 'id'> = {
    email: `user-${n}-${Date.now()}@test.com`,
    full_name: `Test User ${n}`,
    balance_cents: 10_000_000,
  };
  const data = { ...defaults, ...overrides };
  const rows: UserRow[] = await ds.query(
    `INSERT INTO users (email, full_name, balance_cents)
     VALUES ($1, $2, $3)
     RETURNING id, email, full_name, balance_cents`,
    [data.email, data.full_name, data.balance_cents],
  );
  return Array.isArray(rows[0]) ? (rows as any)[0][0] : rows[0];
}

export interface ProductRow {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
  is_active: boolean;
}

export async function aProduct(
  ds: DataSource,
  overrides: Partial<ProductRow> = {},
): Promise<ProductRow> {
  const n = nextSeq();
  const defaults: Omit<ProductRow, 'id'> = {
    name: `Product ${n}`,
    price_cents: 1000 + n,
    stock: 100,
    is_active: true,
  };
  const data = { ...defaults, ...overrides };
  const rows: ProductRow[] = await ds.query(
    `INSERT INTO products (name, price_cents, stock, is_active)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, price_cents, stock, is_active`,
    [data.name, data.price_cents, data.stock, data.is_active],
  );
  return Array.isArray(rows[0]) ? (rows as any)[0][0] : rows[0];
}

export interface OrderRow {
  id: string;
  user_id: string;
  status: string;
  total_cents: number;
  shipping_country: string;
}

export async function anOrder(
  ds: DataSource,
  overrides: Partial<OrderRow> & { user_id: string },
): Promise<OrderRow> {
  const defaults = {
    status: 'pending',
    total_cents: 0,
    shipping_country: 'US',
  };
  const data = { ...defaults, ...overrides };
  const rows: OrderRow[] = await ds.query(
    `INSERT INTO orders (user_id, status, total_cents, shipping_country)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, status, total_cents, shipping_country`,
    [data.user_id, data.status, data.total_cents, data.shipping_country],
  );
  return Array.isArray(rows[0]) ? (rows as any)[0][0] : rows[0];
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export async function anOrderItem(
  ds: DataSource,
  overrides: Partial<OrderItemRow> & {
    order_id: string;
    product_id: string;
  },
): Promise<OrderItemRow> {
  const defaults = {
    quantity: 1,
    unit_price_cents: 1000,
    line_total_cents: 1000,
  };
  const data = { ...defaults, ...overrides };
  const rows: OrderItemRow[] = await ds.query(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, line_total_cents)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, order_id, product_id, quantity, unit_price_cents, line_total_cents`,
    [data.order_id, data.product_id, data.quantity, data.unit_price_cents, data.line_total_cents],
  );
  return Array.isArray(rows[0]) ? (rows as any)[0][0] : rows[0];
}
