import { Pool } from 'pg';

export function createPool(): Pool {
  const url = process.env.DB_URL ?? process.env.DATABASE_URL;
  if (url) {
    return new Pool({ connectionString: url, max: 5 });
  }
  if (!process.env.DB_HOST) {
    throw new Error('DATABASE_URL: unbound variable');
  }
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 5,
  });
}
