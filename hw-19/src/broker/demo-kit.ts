import { Client } from 'pg';
import type { ConfirmChannel } from 'amqplib';
import { connectBroker } from './connection';
import {
  databaseUrl,
  ensureProcessedEventsTable,
  truncateProcessedEvents,
} from './effect';
import { assertTopology, closeBroker, resetWorkQueues } from './topology';

export async function withDemoInfra<T>(
  fn: (ctx: { db: Client; ch: ConfirmChannel }) => Promise<T>,
): Promise<T> {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  const conn = await connectBroker();
  const ch = await conn.createConfirmChannel();
  await resetWorkQueues(ch);
  await assertTopology(ch);
  await ensureProcessedEventsTable(db);
  await truncateProcessedEvents(db);
  try {
    return await fn({ db, ch });
  } finally {
    await closeBroker(conn, ch);
    await db.end();
  }
}
