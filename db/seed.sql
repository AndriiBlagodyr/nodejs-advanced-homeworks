BEGIN;

SET LOCAL synchronous_commit = off;

INSERT INTO products (id, name, price_cents, is_active, created_at)
SELECT
  product_number,
  CASE product_number
    WHEN 1 THEN 'Mechanical Keyboard'
    WHEN 2 THEN 'Wireless Mouse'
    WHEN 3 THEN 'USB-C Hub'
    WHEN 4 THEN 'Laptop Stand'
    WHEN 5 THEN 'Web Camera'
    ELSE 'Marketplace Accessory ' || product_number
  END,
  CASE product_number
    WHEN 1 THEN 12900
    WHEN 2 THEN 5900
    WHEN 3 THEN 7900
    WHEN 4 THEN 4500
    WHEN 5 THEN 9900
    ELSE 1000 + (product_number % 250) * 100
  END,
  product_number % 50 <> 0,
  timestamptz '2023-01-01 00:00:00+00'
    + (product_number * interval '1 day')
FROM generate_series(1, 500) AS generated(product_number);

INSERT INTO users (id, email, full_name, created_at)
SELECT
  user_number,
  'user' || to_char(user_number, 'FM00000') || '@marketplace.example',
  'Customer ' || user_number,
  timestamptz '2022-01-01 00:00:00+00'
    + ((user_number % 730) * interval '1 day')
FROM generate_series(1, 8000) AS generated(user_number);

INSERT INTO users (id, email, full_name, created_at)
VALUES (
  8001,
  'power.user@marketplace.example',
  'Power User',
  timestamptz '2021-01-01 00:00:00+00'
);

INSERT INTO orders (
  id,
  user_id,
  status,
  total_cents,
  shipping_country,
  idempotency_key,
  created_at
)
SELECT
  order_number,
  CASE
    WHEN order_number % 12 = 0 THEN 8001
    WHEN order_number % 100 < 45 THEN 1 + (order_number % 400)
    ELSE 1 + (order_number % 8000)
  END,
  CASE
    WHEN order_number % 100 < 3 THEN 'refunded'
    WHEN order_number % 100 < 10 THEN 'cancelled'
    WHEN order_number % 100 < 28 THEN 'pending'
    ELSE 'completed'
  END,
  product.price_cents * (1 + order_number % 3),
  CASE
    WHEN order_number % 20 < 8 THEN 'US'
    WHEN order_number % 20 < 12 THEN 'DE'
    WHEN order_number % 20 < 14 THEN 'GB'
    WHEN order_number % 20 < 16 THEN 'UA'
    WHEN order_number % 20 < 18 THEN 'PL'
    WHEN order_number % 20 = 18 THEN 'CA'
    ELSE 'FR'
  END,
  'seed-order-' || order_number,
  CASE
    WHEN order_number % 12 = 0 THEN
      timestamptz '2025-08-01 00:00:00+00'
      + ((order_number % 31) * interval '1 day')
      + (((order_number * 7919) % 86400) * interval '1 second')
    ELSE
      timestamptz '2024-01-01 00:00:00+00'
      + (((order_number * 37) % 600) * interval '1 day')
      + (((order_number * 7919) % 86400) * interval '1 second')
  END
FROM generate_series(1, 120000) AS generated(order_number)
JOIN products AS product
  ON product.id = 1 + (order_number % 500);

INSERT INTO order_items (
  id,
  order_id,
  product_id,
  quantity,
  unit_price_cents,
  line_total_cents
)
SELECT
  orders.id,
  orders.id,
  product.id,
  1 + orders.id % 3,
  product.price_cents,
  product.price_cents * (1 + orders.id % 3)
FROM orders
JOIN products AS product
  ON product.id = 1 + (orders.id % 500);

INSERT INTO idempotency_records (
  idempotency_key,
  order_id,
  request_hash,
  response_status,
  response_body,
  created_at
)
SELECT
  orders.idempotency_key,
  orders.id,
  md5(orders.idempotency_key) || md5(orders.idempotency_key),
  201,
  jsonb_build_object(
    'id', orders.id,
    'status', orders.status,
    'total_cents', orders.total_cents
  ),
  orders.created_at
FROM orders
WHERE orders.id % 20 = 0;

SELECT setval(
  pg_get_serial_sequence('products', 'id'),
  (SELECT max(id) FROM products),
  true
);
SELECT setval(
  pg_get_serial_sequence('users', 'id'),
  (SELECT max(id) FROM users),
  true
);
SELECT setval(
  pg_get_serial_sequence('orders', 'id'),
  (SELECT max(id) FROM orders),
  true
);
SELECT setval(
  pg_get_serial_sequence('order_items', 'id'),
  (SELECT max(id) FROM order_items),
  true
);

COMMIT;

VACUUM (ANALYZE);
