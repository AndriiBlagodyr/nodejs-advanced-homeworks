import { DataSource } from 'typeorm';
import { createDataSourceOptions } from './data-source';
import { IdempotencyRecord, Order, OrderItem, Product, User } from './entities';

const USERS: Array<Pick<User, 'id' | 'email' | 'fullName' | 'balanceCents'>> = [
  { id: '1', email: 'ada@example.com', fullName: 'Ada Lovelace', balanceCents: 10_000_000 },
  { id: '2', email: 'grace@example.com', fullName: 'Grace Hopper', balanceCents: 10_000_000 },
  { id: '3', email: 'alan@example.com', fullName: 'Alan Turing', balanceCents: 10_000_000 },
  { id: '4', email: 'barbara@example.com', fullName: 'Barbara Liskov', balanceCents: 10_000_000 },
  { id: '5', email: 'donald@example.com', fullName: 'Donald Knuth', balanceCents: 10_000_000 },
  { id: '6', email: 'frances@example.com', fullName: 'Frances Allen', balanceCents: 10_000_000 },
  { id: '7', email: 'linus@example.com', fullName: 'Linus Torvalds', balanceCents: 10_000_000 },
  { id: '8', email: 'margaret@example.com', fullName: 'Margaret Hamilton', balanceCents: 10_000_000 },
];

const PRODUCTS: Array<Pick<Product, 'id' | 'name' | 'priceCents' | 'stock' | 'isActive'>> = [
  { id: '1', name: 'Mechanical Keyboard', priceCents: 12900, stock: 100, isActive: true },
  { id: '2', name: 'USB-C Hub', priceCents: 4900, stock: 100, isActive: true },
  { id: '3', name: 'Monitor Arm', priceCents: 8900, stock: 100, isActive: true },
  { id: '4', name: 'Noise Cancelling Headphones', priceCents: 19900, stock: 100, isActive: true },
  { id: '5', name: 'Laptop Stand', priceCents: 3900, stock: 100, isActive: true },
  { id: '6', name: 'Wireless Mouse', priceCents: 5900, stock: 100, isActive: true },
  { id: '7', name: 'Desk Mat', priceCents: 2500, stock: 100, isActive: true },
  { id: '8', name: 'Webcam', priceCents: 7900, stock: 100, isActive: true },
];

const ORDERS: Array<
  Pick<Order, 'id' | 'userId' | 'status' | 'totalCents' | 'shippingCountry'>
> = [
  { id: '1', userId: '1', status: 'completed', totalCents: 17800, shippingCountry: 'US' },
  { id: '2', userId: '2', status: 'completed', totalCents: 32800, shippingCountry: 'DE' },
  { id: '3', userId: '3', status: 'pending', totalCents: 8900, shippingCountry: 'US' },
  { id: '4', userId: '4', status: 'completed', totalCents: 13800, shippingCountry: 'UA' },
  { id: '5', userId: '5', status: 'cancelled', totalCents: 3900, shippingCountry: 'PL' },
  { id: '6', userId: '6', status: 'completed', totalCents: 7400, shippingCountry: 'DE' },
  { id: '7', userId: '7', status: 'pending', totalCents: 7900, shippingCountry: 'US' },
  { id: '8', userId: '8', status: 'refunded', totalCents: 12900, shippingCountry: 'UA' },
];

const ORDER_ITEMS: Array<
  Pick<OrderItem, 'id' | 'orderId' | 'productId' | 'quantity' | 'unitPriceCents' | 'lineTotalCents'>
> = [
  { id: '1', orderId: '1', productId: '1', quantity: 1, unitPriceCents: 12900, lineTotalCents: 12900 },
  { id: '2', orderId: '1', productId: '2', quantity: 1, unitPriceCents: 4900, lineTotalCents: 4900 },
  { id: '3', orderId: '2', productId: '4', quantity: 1, unitPriceCents: 19900, lineTotalCents: 19900 },
  { id: '4', orderId: '2', productId: '1', quantity: 1, unitPriceCents: 12900, lineTotalCents: 12900 },
  { id: '5', orderId: '3', productId: '3', quantity: 1, unitPriceCents: 8900, lineTotalCents: 8900 },
  { id: '6', orderId: '4', productId: '6', quantity: 1, unitPriceCents: 5900, lineTotalCents: 5900 },
  { id: '7', orderId: '4', productId: '8', quantity: 1, unitPriceCents: 7900, lineTotalCents: 7900 },
  { id: '8', orderId: '5', productId: '5', quantity: 1, unitPriceCents: 3900, lineTotalCents: 3900 },
  { id: '9', orderId: '6', productId: '2', quantity: 1, unitPriceCents: 4900, lineTotalCents: 4900 },
  { id: '10', orderId: '6', productId: '7', quantity: 1, unitPriceCents: 2500, lineTotalCents: 2500 },
  { id: '11', orderId: '7', productId: '8', quantity: 1, unitPriceCents: 7900, lineTotalCents: 7900 },
  { id: '12', orderId: '8', productId: '1', quantity: 1, unitPriceCents: 12900, lineTotalCents: 12900 },
];

function hash64(seed: string): string {
  const hex = Buffer.from(seed.padEnd(32, '0')).toString('hex');
  return hex.slice(0, 64);
}

const IDEMPOTENCY_RECORDS: Array<
  Pick<
    IdempotencyRecord,
    'idempotencyKey' | 'orderId' | 'requestHash' | 'responseStatus' | 'responseBody'
  >
> = [
  {
    idempotencyKey: 'create-order-1',
    orderId: '1',
    requestHash: hash64('order-1'),
    responseStatus: 201,
    responseBody: { orderId: '1' },
  },
  {
    idempotencyKey: 'create-order-2',
    orderId: '2',
    requestHash: hash64('order-2'),
    responseStatus: 201,
    responseBody: { orderId: '2' },
  },
  {
    idempotencyKey: 'create-order-4',
    orderId: '4',
    requestHash: hash64('order-4'),
    responseStatus: 201,
    responseBody: { orderId: '4' },
  },
  {
    idempotencyKey: 'create-order-6',
    orderId: '6',
    requestHash: hash64('order-6'),
    responseStatus: 201,
    responseBody: { orderId: '6' },
  },
  {
    idempotencyKey: 'create-order-8',
    orderId: '8',
    requestHash: hash64('order-8'),
    responseStatus: 201,
    responseBody: { orderId: '8' },
  },
];

async function syncIdentity(ds: DataSource, table: string, column = 'id'): Promise<void> {
  await ds.query(
    `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${column}) FROM ${table}), 1))`,
    [table, column],
  );
}

async function seed(): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();

  try {
    for (const user of USERS) {
      await ds.query(
        `INSERT INTO users (id, email, full_name, balance_cents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           full_name = EXCLUDED.full_name,
           balance_cents = EXCLUDED.balance_cents`,
        [user.id, user.email, user.fullName, user.balanceCents],
      );
    }

    for (const product of PRODUCTS) {
      await ds.query(
        `INSERT INTO products (id, name, price_cents, stock, is_active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           price_cents = EXCLUDED.price_cents,
           stock = EXCLUDED.stock,
           is_active = EXCLUDED.is_active`,
        [
          product.id,
          product.name,
          product.priceCents,
          product.stock,
          product.isActive,
        ],
      );
    }

    for (const order of ORDERS) {
      await ds.query(
        `INSERT INTO orders (id, user_id, status, total_cents, shipping_country)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           status = EXCLUDED.status,
           total_cents = EXCLUDED.total_cents,
           shipping_country = EXCLUDED.shipping_country`,
        [order.id, order.userId, order.status, order.totalCents, order.shippingCountry],
      );
    }

    for (const item of ORDER_ITEMS) {
      await ds.query(
        `INSERT INTO order_items
           (id, order_id, product_id, quantity, unit_price_cents, line_total_cents)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           product_id = EXCLUDED.product_id,
           quantity = EXCLUDED.quantity,
           unit_price_cents = EXCLUDED.unit_price_cents,
           line_total_cents = EXCLUDED.line_total_cents`,
        [
          item.id,
          item.orderId,
          item.productId,
          item.quantity,
          item.unitPriceCents,
          item.lineTotalCents,
        ],
      );
    }

    for (const record of IDEMPOTENCY_RECORDS) {
      await ds.query(
        `INSERT INTO idempotency_records
           (idempotency_key, order_id, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           request_hash = EXCLUDED.request_hash,
           response_status = EXCLUDED.response_status,
           response_body = EXCLUDED.response_body`,
        [
          record.idempotencyKey,
          record.orderId,
          record.requestHash,
          record.responseStatus,
          JSON.stringify(record.responseBody),
        ],
      );
    }

    await syncIdentity(ds, 'users');
    await syncIdentity(ds, 'products');
    await syncIdentity(ds, 'orders');
    await syncIdentity(ds, 'order_items');

    const [users, products, orders, items, keys] = await Promise.all([
      ds.getRepository(User).count(),
      ds.getRepository(Product).count(),
      ds.getRepository(Order).count(),
      ds.getRepository(OrderItem).count(),
      ds.getRepository(IdempotencyRecord).count(),
    ]);

    console.log('seed complete');
    console.log(`users=${users} products=${products} orders=${orders} order_items=${items} idempotency_records=${keys}`);
  } finally {
    await ds.destroy();
  }
}

seed().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
