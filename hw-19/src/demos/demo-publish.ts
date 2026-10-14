import { BROKER_PREFETCH } from '../broker/constants';
import { consumeUntil, depths } from '../broker/consume';
import { withDemoInfra } from '../broker/demo-kit';
import { orderPlacedEvent } from '../broker/order-placed.event';
import { publishOrderPlaced } from '../broker/publisher';

async function main(): Promise<void> {
  const result = await withDemoInfra(async ({ db, ch }) => {
    const consume = consumeUntil(ch, {
      db,
      stop: (s) => s.acked >= 5 && s.effect >= 5,
      timeoutMs: 20_000,
    });

    let published = 0;
    for (let i = 1; i <= 5; i += 1) {
      await publishOrderPlaced(
        ch,
        orderPlacedEvent({
          orderId: `demo-pub-${Date.now()}-${i}`,
          userId: '1',
          totalCents: 100 * i,
        }),
      );
      published += 1;
    }

    const stats = await consume;
    const { work, dlq } = await depths(ch);
    return { published, stats, work, dlq };
  });

  const { published, stats, dlq } = result;
  console.log(`published=${published}`);
  console.log(`delivered=${stats.delivered}`);
  console.log(`effect=${stats.effect}`);
  console.log(`acked=${stats.acked}`);
  console.log(`dlq=${dlq}`);
  console.log(`prefetch=${BROKER_PREFETCH}`);

  const ok =
    published === 5 &&
    stats.effect === 5 &&
    dlq === 0 &&
    BROKER_PREFETCH >= 1 &&
    BROKER_PREFETCH <= 2000;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
