import { consumeUntil, depths, readDlqReason } from '../broker/consume';
import { EXCHANGE_EVENTS, ROUTING_ORDER_PLACED } from '../broker/constants';
import { withDemoInfra } from '../broker/demo-kit';

async function main(): Promise<void> {
  const result = await withDemoInfra(async ({ db, ch }) => {
    const consume = consumeUntil(ch, {
      db,
      onPoison: () => 'reject',
      stop: (s) => s.rejected >= 1,
      timeoutMs: 20_000,
    });

    ch.publish(
      EXCHANGE_EVENTS,
      ROUTING_ORDER_PLACED,
      Buffer.from(JSON.stringify({ poison: true, type: 'order.placed' })),
      { persistent: true },
    );
    await ch.waitForConfirms();

    const stats = await consume;
    await new Promise((r) => setTimeout(r, 200));
    const { work, dlq } = await depths(ch);
    const reason = await readDlqReason(ch);
    return { stats, work, dlq, reason };
  });

  const { stats, work, dlq, reason } = result;
  console.log(`rejected=${stats.rejected}`);
  console.log(`work=${work}`);
  console.log(`dlq=${dlq}`);
  console.log(`dlq-reason=${reason ?? 'unknown'}`);
  console.log(`effect=${stats.effect}`);

  const reasons = new Set(['rejected', 'expired', 'maxlen', 'delivery_limit']);
  const ok =
    work === 0 &&
    dlq === 1 &&
    !!reason &&
    reasons.has(reason) &&
    stats.effect === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
