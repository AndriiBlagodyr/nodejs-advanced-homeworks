import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import {
  IdempotencyRecord,
  Order,
  OrderItem,
  Product,
  User,
} from './entities';
import { InitialSchema1726000000000 } from './migrations/1726000000000-InitialSchema';

function postgresConnection(): Record<string, string | number | undefined> {
  if (process.env.DB_URL) {
    return { url: process.env.DB_URL };
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

export function createDataSourceOptions(
  overrides: Partial<DataSourceOptions> = {},
): DataSourceOptions {
  return {
    type: 'postgres',
    ...postgresConnection(),
    synchronize: false,
    logging: false,
    entities: [User, Product, Order, OrderItem, IdempotencyRecord],
    migrations: [InitialSchema1726000000000],
    ...overrides,
  } as DataSourceOptions;
}

export const AppDataSource = new DataSource(createDataSourceOptions());
