import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type Redis from 'ioredis';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import { createDataSourceOptions } from '../data-source';
import { redisConfigured } from '../redis/clients';

export const DEMO_PRODUCT_FIRST_ID = 9100;

/** Pending migrations only: every demo must work on an empty database. */
export async function migrateDb(): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();
  try {
    await ds.runMigrations({ transaction: 'each' });
  } finally {
    await ds.destroy();
  }
}

/** Migrations + demo products (ids 9100…), so a fresh database works too. */
export async function prepareDb(
  productCount: number,
  overrides: Partial<DataSourceOptions> = {},
): Promise<DataSource> {
  const ds = new DataSource(createDataSourceOptions(overrides));
  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });
  await ds.query(
    `INSERT INTO products (id, name, price_cents, stock, is_active)
     SELECT g, 'Redis demo product ' || g, 1000 + (g - $1), 100, true
       FROM generate_series($1::int, $1::int + $2::int - 1) AS g
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    [DEMO_PRODUCT_FIRST_ID, productCount],
  );
  return ds;
}

/** SCAN + DEL: never KEYS on a live instance. */
export async function deleteKeys(redis: Redis, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  let cursor = '0';
  const all: string[] = [];
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    all.push(...keys);
  } while (cursor !== '0');
  return all;
}

export type RunningApp = { app: INestApplication; base: string };

/** One "pod": its own Nest container, its own Redis and DB clients, its own port. */
export async function bootApp(): Promise<RunningApp> {
  if (!redisConfigured()) {
    throw new Error('REDIS_URL and REDIS_QUEUE_URL must be set');
  }
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}` };
}
