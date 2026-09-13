CREATE INDEX idx_orders_user_created_at
  ON orders (user_id, created_at DESC)
  INCLUDE (id, status, total_cents);

CREATE INDEX idx_orders_pending_created_at
  ON orders (created_at ASC)
  INCLUDE (id, user_id, total_cents)
  WHERE status = 'pending';

CREATE INDEX idx_orders_country_status_created_at
  ON orders (shipping_country, status, created_at DESC)
  INCLUDE (id, total_cents);
