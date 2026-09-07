SELECT
  orders.id,
  orders.user_id,
  orders.total_cents,
  orders.created_at
FROM orders
WHERE orders.status = 'pending'
  AND orders.created_at >= timestamptz '2025-08-15 00:00:00+00'
  AND orders.created_at < timestamptz '2025-09-01 00:00:00+00'
ORDER BY orders.created_at ASC
LIMIT 100;
