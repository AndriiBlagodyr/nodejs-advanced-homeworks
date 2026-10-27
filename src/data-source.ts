import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import {
  IdempotencyRecord,
  Job,
  Order,
  OrderConfirmation,
  OrderItem,
  OutboxMessage,
  ProcessedEvent,
  ProcessedMessage,
  Product,
  User,
} from './entities';
import { InitialSchema1726000000000 } from './migrations/1726000000000-InitialSchema';
import { AddCheckoutAndJobs1726100000000 } from './migrations/1726100000000-AddCheckoutAndJobs';
import { ProcessedEvents1726200000000 } from './migrations/1726200000000-ProcessedEvents';
import { OutboxAndInbox1726300000000 } from './migrations/1726300000000-OutboxAndInbox';
import { OutboxRetryAndRetention1726400000000 } from './migrations/1726400000000-OutboxRetryAndRetention';
import { Auth1726500000000 } from './migrations/1726500000000-Auth';
import { AuthFamilyDenylist1726600000000 } from './migrations/1726600000000-AuthFamilyDenylist';

function postgresConnection(): Record<string, string | number | undefined> {
  if (process.env.DB_URL || process.env.DATABASE_URL) {
    return { url: process.env.DB_URL ?? process.env.DATABASE_URL };
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
    entities: [
      User,
      Product,
      Order,
      OrderItem,
      IdempotencyRecord,
      Job,
      ProcessedEvent,
      OutboxMessage,
      ProcessedMessage,
      OrderConfirmation,
    ],
    migrations: [
      InitialSchema1726000000000,
      AddCheckoutAndJobs1726100000000,
      ProcessedEvents1726200000000,
      OutboxAndInbox1726300000000,
      OutboxRetryAndRetention1726400000000,
      Auth1726500000000,
      AuthFamilyDenylist1726600000000,
    ],
    ...overrides,
  } as DataSourceOptions;
}

export const AppDataSource = new DataSource(createDataSourceOptions());
