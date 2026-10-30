import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { createDataSourceOptions } from '../../src/data-source';

let container: StartedPostgreSqlContainer;
let dataSource: DataSource;

export async function setupTestDb(): Promise<DataSource> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  dataSource = new DataSource(
    createDataSourceOptions({ url, migrationsRun: true, logging: false }),
  );
  await dataSource.initialize();
  return dataSource;
}

export async function teardownTestDb(): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  if (container) await container.stop();
}

export function getDataSource(): DataSource {
  return dataSource;
}

export async function truncateAll(ds: DataSource): Promise<void> {
  await ds.query(`
    TRUNCATE TABLE idempotency_records, order_items, orders, jobs, products, users
    RESTART IDENTITY CASCADE
  `);
}
