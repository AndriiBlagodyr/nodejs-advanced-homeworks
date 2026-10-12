import { connectBroker } from '../broker/connection';
import { assertTopology } from '../broker/topology';
import { startOrderPlacedConsumer } from './consumer';
import { createPool } from './pg';

async function main(): Promise<void> {
  const pool = createPool();
  const conn = await connectBroker();
  const ch = await conn.createChannel();
  await assertTopology(ch);
  const consumer = await startOrderPlacedConsumer(ch, pool);
  console.log('order.placed consumer started');

  const shutdown = async () => {
    await consumer.stop();
    await ch.close();
    await conn.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
