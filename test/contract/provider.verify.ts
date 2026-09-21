import path from 'path';
import { Verifier } from '@pact-foundation/pact';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';
import { createDataSourceOptions } from '../../src/data-source';

let app: INestApplication;
let container: StartedPostgreSqlContainer;
let seedDs: DataSource;

async function seedState(ds: DataSource): Promise<void> {
  await ds.query(`TRUNCATE TABLE idempotency_records, order_items, orders, jobs, products, users RESTART IDENTITY CASCADE`);
  await ds.query(
    `INSERT INTO users (id, email, full_name, balance_cents) VALUES (1, 'pact@test.com', 'Pact User', 10000000)
     ON CONFLICT (id) DO NOTHING`,
  );
  await ds.query(
    `INSERT INTO products (id, name, price_cents, stock) VALUES (1, 'Widget', 500, 50)
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  seedDs = new DataSource(createDataSourceOptions({ url, migrationsRun: true }));
  await seedDs.initialize();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
}

async function teardown(): Promise<void> {
  await app?.close();
  await seedDs?.destroy();
  await container?.stop();
}

async function run(): Promise<void> {
  await setup();

  const address = app.getHttpServer().address();
  const port = typeof address === 'string' ? 3000 : address.port;
  const providerBaseUrl = `http://127.0.0.1:${port}`;

  const providerVersion = process.env.PROVIDER_VERSION ?? '1.0.0-local';
  const brokerUrl = process.env.PACT_BROKER_URL;

  const opts: any = {
    providerBaseUrl,
    provider: 'MarketplaceAPI',
    providerVersion,
    stateHandlers: {
      'products exist': async () => {
        await seedState(seedDs);
      },
      'product 1 exists': async () => {
        await seedState(seedDs);
      },
    },
    // Always verify from local pact file
    pactUrls: [
      path.resolve(process.cwd(), 'pacts', 'MarketplaceFrontend-MarketplaceAPI.json'),
    ],
  };

  // Publish verification results to broker if URL is provided
  if (brokerUrl) {
    opts.publishVerificationResult = true;
    opts.pactBrokerUrl = brokerUrl;
    if (process.env.PACT_BROKER_TOKEN) {
      opts.pactBrokerToken = process.env.PACT_BROKER_TOKEN;
    }
    if (process.env.PACT_BROKER_USERNAME || !process.env.PACT_BROKER_TOKEN) {
      opts.pactBrokerUsername = process.env.PACT_BROKER_USERNAME ?? 'pact';
      opts.pactBrokerPassword = process.env.PACT_BROKER_PASSWORD ?? 'pact';
    }
  }

  try {
    const verifier = new Verifier(opts);
    await verifier.verifyProvider();
    console.log('Provider verification passed');
  } finally {
    await teardown();
  }
}

run().catch((err) => {
  console.error('Provider verification failed:', err);
  process.exit(1);
});
