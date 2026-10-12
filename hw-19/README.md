# HW-19 — Async events via RabbitMQ

`order.placed` is published from checkout with publisher confirms. A consumer
applies an idempotent effect (`INSERT … ON CONFLICT DO NOTHING` on `event_id`),
acks only after that write, and dead-letters poison messages. Realtime from
HW-18 still lives in this tree; the snapshot is `hw-18/`.

Previous snapshots: `hw-03/` … `hw-16/`, `hw-18/`.

## Async-події через RabbitMQ

Topology (declared by the **consumer/bootstrap**, not the producer): topic
exchange `shop.events`, quorum queue `shop.order.placed` bound with routing key
`order.placed`, DLX `shop.dlx` → `shop.order.placed.dlq`. Alternate exchange
`shop.unroutable` catches unbound routing keys.

Publication uses `createConfirmChannel` + `waitForConfirms`. The body is a
contract (`eventId`, `type`, `occurredAt`, `data`), not a spread ORM entity.
`eventId` is `order.placed:<orderId>` so the consumer can recognise a duplicate.

Consumer: `noAck: false`, `channel.prefetch(32)`, ack after the effect.
**prefetch = 32** because handlers are ~2–10 ms: 32 × 10 ms = 320 ms, which is
far below the stock `consumer_timeout` of 30 minutes. prefetch=1 would starve a
fast worker; 32 keeps several messages in flight without approaching the
timeout.

Dead-letter demo uses `reject(requeue=false)` so the death reason is
`rejected` (one of the four RabbitMQ reasons). Duplicate demo applies the
effect, then `nack(requeue=true)` **once** (not `channel.close()`): the broker
redelivers, the second delivery hits `ON CONFLICT`, `effect` stays 1,
`deliveries` ≥ 2.

### Numbers from local runs

| Demo | Lines |
| --- | --- |
| `demo:publish` | `published=5` `delivered=5` `effect=5` `acked=5` `dlq=0` `prefetch=32` |
| `demo:dlq` | `rejected=1` `work=0` `dlq=1` `dlq-reason=rejected` `effect=0` |
| `demo:duplicate` | `deliveries=2` `effect=1` `skipped=1` |

This is **at-least-once delivery**, not exactly-once on the wire. A crash after
the effect and before ack makes the broker redeliver; that is a second
delivery of the same `eventId`. Exactly-once **result** comes from the
idempotent insert into `processed_events` (Postgres), which survives a
consumer restart. Saying “RabbitMQ gives exactly-once” would be wrong.

The remaining hole is between “marked processed” and “applied a second
side effect”: today the insert **is** the effect, so those two are one
statement. A separate UPDATE plus a later mark would need one COMMIT
(outbox / processed_messages in HW-22).

Idempotency is a property of the operation (`ON CONFLICT DO NOTHING` on
`event_id`). `qty = qty - 1` is not idempotent; a key would only make retries
safe if the decrement were gated by that key.

Default `dead-letter-strategy` is enough for this homework; overflow
`reject-publish` with at-least-once DL is a known footgun and is not used
here.

## Commands

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export SKIP_VAULT=1
npm ci
npm run build
npm run migrate
npm run demo:publish
npm run demo:dlq
npm run demo:duplicate
```

## Grading

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export SKIP_VAULT=1
npm ci
npm run build
npm run migrate
npm run demo:publish
npm run demo:dlq
npm run demo:duplicate
```
