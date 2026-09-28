import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';
import { createDataSourceOptions } from '../../src/data-source';

let app: INestApplication;
let container: StartedPostgreSqlContainer;
let seedDs: DataSource;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  seedDs = new DataSource(createDataSourceOptions({ url, migrationsRun: true }));
  await seedDs.initialize();
  await seedDs.query(
    `INSERT INTO users (id, email, full_name, balance_cents) VALUES (1, 'e2e@test.com', 'E2E User', 10000000)
     ON CONFLICT (id) DO NOTHING`,
  );
  await seedDs.query(
    `INSERT INTO products (id, name, price_cents, stock) VALUES (1, 'E2E Widget', 500, 50)
     ON CONFLICT (id) DO NOTHING`,
  );
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

describe('Marketplace E2E', () => {
  it('POST /orders -> GET /orders/:id (happy path)', async () => {
    const createRes = await supertest(app.getHttpServer())
      .post('/orders')
      .send({ items: [{ product_id: 1, quantity: 2 }] })
      .expect(201);

    expect(createRes.body).toHaveProperty('id');
    expect(createRes.body.total_cents).toBe(1000);
    expect(createRes.headers.location).toMatch(/^\/orders\/\d+$/);

    const orderId = createRes.body.id;
    const getRes = await supertest(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .expect(200);

    expect(getRes.body.id).toBe(orderId);
    expect(getRes.body.items).toHaveLength(1);
  });

  it('GET /orders/999999 returns 404', async () => {
    await supertest(app.getHttpServer()).get('/orders/999999').expect(404);
  });

  it('POST /orders with invalid body returns 400', async () => {
    await supertest(app.getHttpServer())
      .post('/orders')
      .send({ items: [] })
      .expect(400);
  });
});
