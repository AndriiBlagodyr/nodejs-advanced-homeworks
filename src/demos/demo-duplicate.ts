import { consumeUntil } from '../broker/consume';
import { withDemoInfra } from '../broker/demo-kit';
import { orderPlacedEvent } from '../broker/order-placed.event';
import { publishOrderPlaced } from '../broker/publisher';

async function main(): Promise<void> {
  const result = await withDemoInfra(async ({ db, ch }) => {
    const consume = consumeUntil(ch, {
      db,
      afterEffect: (_msg, _applied, redelivered) =>
        redelivered ? 'ack' : 'nack-requeue',
      stop: (s) => s.delivered >= 2 && s.acked >= 1 && s.effect === 1,
      timeoutMs: 20_000,
    });

    await publishOrderPlaced(
      ch,
      orderPlacedEvent({
        orderId: `demo-dup-${Date.now()}`,
        userId: '1',
        totalCents: 500,
      }),
    );

    return consume;
  });

  console.log(`deliveries=${result.delivered}`);
  console.log(`effect=${result.effect}`);
  console.log(`skipped=${result.skipped}`);

  const ok = result.delivered >= 2 && result.effect === 1;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
