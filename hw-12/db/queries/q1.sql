SELECT
  orders.id,
  orders.status,
  orders.total_cents,
  orders.created_at
FROM orders
WHERE orders.user_id = (
    SELECT users.id
    FROM users
    WHERE users.email = 'power.user@marketplace.example'
  )
  AND orders.created_at >= timestamptz '2025-08-01 00:00:00+00'
  AND orders.created_at < timestamptz '2025-09-01 00:00:00+00'
ORDER BY orders.created_at DESC
LIMIT 50;
