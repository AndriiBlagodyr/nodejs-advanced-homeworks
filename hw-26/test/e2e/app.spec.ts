import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ensureEphemeralAuthEnv } from '../../src/demos/ephemeral-auth';
import { hashPassword } from '../../src/auth/password';
import { configureApp } from '../../src/configure-app';
import { createDataSourceOptions } from '../../src/data-source';

let app: INestApplication;
let container: StartedPostgreSqlContainer;
let seedDs: DataSource;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  ensureEphemeralAuthEnv();

  seedDs = new DataSource(createDataSourceOptions({ url, migrationsRun: true }));
  await seedDs.initialize();
  const passwordHash = await hashPassword('e2e-password');
  await seedDs.query(
    `INSERT INTO users (id, email, full_name, balance_cents, password_hash, role) VALUES
       (1, 'e2e@test.com',        'E2E User',   10000000, $1, 'buyer'),
       (2, 'e2e-other@test.com',  'E2E Other',  10000000, $1, 'buyer'),
       (3, 'e2e-seller@test.com', 'E2E Seller', 10000000, $1, 'seller')
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    [passwordHash],
  );
  await seedDs.query(
    `INSERT INTO products (id, name, price_cents, stock) VALUES (1, 'E2E Widget', 500, 50)
     ON CONFLICT (id) DO NOTHING`,
  );
  await seedDs.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users))`);
  await seedDs.query(`SELECT setval(pg_get_serial_sequence('products', 'id'), (SELECT max(id) FROM products))`);
  await seedDs.destroy();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await container?.stop();
});

type Pair = { access_token: string; refresh_token: string };

async function loginPair(email = 'e2e@test.com'): Promise<Pair> {
  const res = await supertest(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: 'e2e-password' })
    .expect(200);
  return res.body as Pair;
}

async function login(email?: string): Promise<string> {
  return (await loginPair(email)).access_token;
}

function refresh(token: string) {
  return supertest(app.getHttpServer()).post('/auth/refresh').send({ refresh_token: token });
}

async function placeOrder(token: string): Promise<number> {
  const res = await supertest(app.getHttpServer())
    .post('/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ product_id: 1, quantity: 1 }] })
    .expect(201);
  return res.body.id as number;
}

describe('Auth E2E', () => {
  function me(token: string) {
    return supertest(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${token}`);
  }

  it('refresh reuse revokes the whole family, access tokens included', async () => {
    const { access_token: a1, refresh_token: r1 } = await loginPair();
    const rotated = await refresh(r1).expect(200);
    const { access_token: a2, refresh_token: r2 } = rotated.body as Pair;
    await me(a2).expect(200);

    await refresh(r1).expect(401);
    await refresh(r2).expect(401);
    await me(a1).expect(401);
    await me(a2).expect(401);
  });

  it('logout kills every access token of the login and the refresh family', async () => {
    const { access_token: a1, refresh_token: r1 } = await loginPair();
    const { access_token: a2, refresh_token: r2 } = (await refresh(r1).expect(200)).body as Pair;
    const other = await login();
    await me(a1).expect(200);

    await supertest(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${a2}`)
      .expect(204);
    await me(a2).expect(401);
    await me(a1).expect(401);
    await refresh(r2).expect(401);
    await me(other).expect(200);
  });

  it('logout sweeps expired refresh rows', async () => {
    const ds = new DataSource(
      createDataSourceOptions({ url: process.env.DATABASE_URL, migrationsRun: false }),
    );
    await ds.initialize();
    try {
      await ds.query(
        `INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at)
         VALUES (repeat('a', 64), gen_random_uuid(), 1, now() - interval '1 second')`,
      );
      const access = await login();
      await supertest(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${access}`)
        .expect(204);
      const left = await ds.query(`SELECT 1 FROM refresh_tokens WHERE expires_at <= now()`);
      expect(left).toHaveLength(0);
    } finally {
      await ds.destroy();
    }
  });

  it('401 without a token, 403 on someone else\'s order, 200 for the owner', async () => {
    const owner = await login();
    const other = await login('e2e-other@test.com');
    const orderId = await placeOrder(owner);
    const server = app.getHttpServer();

    await supertest(server).get(`/orders/${orderId}`).expect(401);
    await supertest(server).get(`/orders/${orderId}`).set('Authorization', `Bearer ${other}`).expect(403);
    await supertest(server).get(`/orders/${orderId}`).set('Authorization', `Bearer ${owner}`).expect(200);
  });

  it('the order list only contains the caller\'s own orders', async () => {
    const owner = await login();
    const other = await login('e2e-other@test.com');
    const orderId = await placeOrder(owner);

    const res = await supertest(app.getHttpServer())
      .get('/orders?limit=100')
      .set('Authorization', `Bearer ${other}`)
      .expect(200);
    const ids = (res.body.items as Array<{ id: number }>).map((o) => o.id);
    expect(ids).not.toContain(orderId);
  });

  it('a buyer may cancel their own order but not complete it', async () => {
    const owner = await login();
    const orderId = await placeOrder(owner);
    const server = app.getHttpServer();

    await supertest(server)
      .patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ status: 'completed' })
      .expect(403);
    await supertest(server)
      .patch(`/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ status: 'cancelled' })
      .expect(200);
  });

  it('product writes: buyer 403, seller 201, edited payload 401', async () => {
    const buyer = await login();
    const seller = await login('e2e-seller@test.com');
    const body = { name: 'E2E new product', price_cents: 100 };
    const server = app.getHttpServer();

    await supertest(server).post('/products').set('Authorization', `Bearer ${buyer}`).send(body).expect(403);
    await supertest(server).post('/products').set('Authorization', `Bearer ${seller}`).send(body).expect(201);

    const parts = buyer.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.role = 'admin';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    await supertest(server)
      .post('/products')
      .set('Authorization', `Bearer ${parts.join('.')}`)
      .send(body)
      .expect(401);
  });
});

describe('Marketplace E2E', () => {
  it('POST /orders -> GET /orders/:id (happy path)', async () => {
    const token = await login();
    const createRes = await supertest(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: 1, quantity: 2 }] })
      .expect(201);

    expect(createRes.body).toHaveProperty('id');
    expect(createRes.body.total_cents).toBe(1000);
    expect(createRes.headers.location).toMatch(/^\/orders\/\d+$/);

    const orderId = createRes.body.id;
    const getRes = await supertest(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(getRes.body.id).toBe(orderId);
    expect(getRes.body.items).toHaveLength(1);
  });

  it('GET /orders/999999 returns 404', async () => {
    const token = await login();
    await supertest(app.getHttpServer())
      .get('/orders/999999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('POST /orders with invalid body returns 400', async () => {
    const token = await login();
    await supertest(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [] })
      .expect(400);
  });
});
