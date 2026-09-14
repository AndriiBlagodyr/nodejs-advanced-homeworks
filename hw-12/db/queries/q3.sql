SELECT
  orders.id,
  orders.total_cents,
  orders.created_at
FROM orders
WHERE orders.shipping_country = 'DE'
  AND orders.status = 'completed'
  AND orders.created_at >= timestamptz '2025-08-01 00:00:00+00'
  AND orders.created_at < timestamptz '2025-09-01 00:00:00+00'
ORDER BY orders.created_at DESC
LIMIT 50;
