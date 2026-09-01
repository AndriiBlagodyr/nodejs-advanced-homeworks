CREATE TABLE IF NOT EXISTS app_metadata (
  key text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO app_metadata (key, value)
VALUES ('service', 'marketplace-api')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
