import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ensureEphemeralAuthEnv } from './ephemeral-auth';
import { hashPassword } from '../auth/password';
import { configureApp } from '../configure-app';
import { drainOutbox } from '../outbox/relay';
import { counts, DEMO_PRODUCT_ID, DEMO_USER_ID, fail, report, sleep, waitFor, withDemo } from './demo-kit';

/**
 * Happy path through the real HTTP edge: two concurrent POST /orders with the
 * same Idempotency-Key → one order, one outbox row, one publish, one effect.
 */
const OUTBOX_DEMO_PASSWORD = 'outbox-demo-password';

async function main(): Promise<void> {
  const result = await withDemo(async ({ ds, pool, relayCh, stats }) => {
    ensureEphemeralAuthEnv();
    await ds.query(`UPDATE users SET password_hash = $1, role = 'buyer' WHERE id = $2`, [
      await hashPassword(OUTBOX_DEMO_PASSWORD),
      DEMO_USER_ID,
    ]);

    const app = await NestFactory.create(AppModule, { logger: ['error'] });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'outbox-demo@example.com',
        password: OUTBOX_DEMO_PASSWORD,
      }),
    });
    const { access_token: accessToken } = (await login.json()) as { access_token?: string };
    if (!accessToken) throw new Error(`outbox demo login failed: ${login.status}`);

    const key = `demo-outbox-${randomUUID()}`;
    const send = () =>
      fetch(`${base}/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ items: [{ product_id: Number(DEMO_PRODUCT_ID), quantity: 1 }] }),
      });

    let responses: Array<{ status: number; id: number; replayed: boolean }>;
    try {
      responses = await Promise.all(
        [send(), send()].map(async (p) => {
          const res = await p;
          const body = (await res.json()) as { id: number };
          return {
            status: res.status,
            id: body.id,
            replayed: res.headers.get('idempotent-replayed') === 'true',
          };
        }),
      );
    } finally {
      await app.close();
    }

    const published = await drainOutbox(pool, relayCh);
    await waitFor(() => stats.applied + stats.skipped >= 1);
    await sleep(500);

    return { responses, published, stats: { ...stats }, c: await counts(pool) };
  });

  const { responses, published, stats, c } = result;
  const requests = responses.filter((r) => r.status === 201).length;
  const sameOrder = responses.every((r) => r.id === responses[0].id) ? 1 : 0;
  const replayed = responses.filter((r) => r.replayed).length;

  report(
    {
      requests,
      'same-order': sameOrder,
      replayed,
      orders: c.orders,
      outbox: c.outbox,
      published,
      'outbox-published': c.outboxPublished,
      deliveries: stats.deliveries,
      effect: c.effect,
      processed: c.processed,
    },
    requests === 2 &&
      sameOrder === 1 &&
      c.orders === 1 &&
      c.outbox === 1 &&
      published === 1 &&
      c.outboxPublished === 1 &&
      stats.deliveries >= 1 &&
      c.effect === 1 &&
      c.processed === 1,
  );
}

main().catch(fail);
