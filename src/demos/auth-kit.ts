import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { hashPassword } from '../auth/password';
import type { Role } from '../auth/tokens';
import { configureApp } from '../configure-app';
import { createDataSourceOptions } from '../data-source';

export const DEMO_PASSWORD = 'hw24-demo-password';

export async function migrate(): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();
  try {
    await ds.runMigrations({ transaction: 'each' });
  } finally {
    await ds.destroy();
  }
}

/** Removes this demo's users (and their orders and refresh tokens) so a rerun starts clean. */
export async function resetAuthUsers(emailLike: string): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();
  try {
    await ds.query(
      `DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [emailLike],
    );
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [emailLike]);
    await ds.query(
      `DELETE FROM order_items WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'HW24 %')`,
    );
    await ds.query(`DELETE FROM products WHERE name LIKE 'HW24 %'`);
  } finally {
    await ds.destroy();
  }
}

export async function insertUser(email: string, role: Role, fullName: string): Promise<string> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();
  try {
    const hash = await hashPassword(DEMO_PASSWORD);
    const rows = await ds.query<Array<{ id: string }>>(
      `INSERT INTO users (email, full_name, balance_cents, password_hash, role)
       VALUES ($1, $2, 10000000, $3, $4)
       RETURNING id::text AS id`,
      [email, fullName, hash, role],
    );
    return rows[0].id;
  } finally {
    await ds.destroy();
  }
}

export async function insertOrder(userId: string): Promise<string> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();
  try {
    const rows = await ds.query<Array<{ id: string }>>(
      `INSERT INTO orders (user_id, status, total_cents, shipping_country)
       VALUES ($1, 'pending', 1000, 'US')
       RETURNING id::text AS id`,
      [userId],
    );
    return rows[0].id;
  } finally {
    await ds.destroy();
  }
}

export async function dbQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();
  try {
    return await ds.query<T>(sql, params);
  } finally {
    await ds.destroy();
  }
}

export type Running = { app: INestApplication; base: string };

export async function bootApi(): Promise<Running> {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}` };
}

export async function call(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return { status: res.status, body };
}

/** Same three lines the brief shows: new payload, old signature. No key involved. */
export function tamperRole(access: string): string {
  const parts = access.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { role?: string };
  payload.role = 'admin';
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return parts.join('.');
}
