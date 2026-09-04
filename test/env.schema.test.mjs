import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnv } from '../dist/config/env.schema.js';

test('environment values are coerced and defaults are applied', () => {
  const env = validateEnv({
    DB_URL: 'postgresql://app@localhost:5432/marketplace',
    PORT: '3100',
  });

  assert.equal(env.PORT, 3100);
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.DB_PASSWORD_FILE, 'secrets/db_password');
});

test('all invalid environment variables are reported together', () => {
  assert.throws(
    () =>
      validateEnv({
        PORT: 'not-a-number',
        NODE_ENV: 'staging',
      }),
    (error) => {
      assert.match(error.message, /DB_URL/);
      assert.match(error.message, /PORT/);
      assert.match(error.message, /NODE_ENV/);
      return true;
    },
  );
});

test('database passwords are rejected in DB_URL', () => {
  assert.throws(
    () =>
      validateEnv({
        DB_URL: 'postgresql://app:secret@localhost:5432/marketplace',
      }),
    /DB_PASSWORD_FILE/,
  );
});
