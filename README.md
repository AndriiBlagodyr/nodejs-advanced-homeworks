# HW-22 — Transactional outbox and idempotency

Placing an order (`POST /orders`) now tells the outside world about it without a
dual write. The order rows, the `Idempotency-Key` claim and the `order.placed`
outbox row commit in one Postgres transaction. A separate relay moves the
outbox to RabbitMQ. The consumer applies the effect idempotently.

Previous snapshots: `hw-03/` … `hw-16/`, `hw-18/`, `hw-19/` (RabbitMQ topology,
manual ack, DLQ — still used here as the transport).

## Outbox та ідемпотентність

### Pieces

| Piece | Where |
| --- | --- |
| Migration: `outbox`, partial index `WHERE published_at IS NULL`, `processed_messages`, `order_confirmations` | `src/migrations/1726300000000-OutboxAndInbox.ts` |
| Business operation: order + items + idempotency claim + outbox row in one `dataSource.transaction` | `src/orders/place-order.ts` |
| Event contract (`toOrderPlacedEvent`), not the ORM entity | `src/outbox/order-placed.event.ts` |
| Relay: `FOR UPDATE SKIP LOCKED` → publish (confirm channel) → `UPDATE published_at` | `src/outbox/relay.ts`, worker `src/outbox/relay-main.ts` |
| Idempotent consumer | `src/outbox/consumer.ts`, worker `src/outbox/consumer-main.ts` |
| Demos | `src/demos/demo-*.ts` |

The broker is RabbitMQ from `docker-compose.yml`: a separate process from
Postgres, so there really are two resource managers and no shared COMMIT.

Outbox columns follow the Debezium Outbox Event Router roles: `id`,
`aggregate_type`, `aggregate_id`, `type`, `payload jsonb`, plus `created_at`,
`published_at` (NULL = not relayed yet) and `attempts`. Debezium's canonical
names are `aggregatetype` / `aggregateid`, so moving to CDC means setting
`route.by.field=aggregate_type` and `table.field.event.key=aggregate_id` (or
renaming the columns). Consumers do not change.

### Three levels of idempotency

1. **Natural key (effect).** The effect is "record an order confirmation":
   `INSERT INTO order_confirmations … ON CONFLICT (order_id) DO NOTHING`.
   Repeating it changes nothing, unlike `qty = qty - 1`.
2. **Inbox.** `INSERT INTO processed_messages (message_id, consumer) … ON
   CONFLICT DO NOTHING` and the effect run in **one** transaction on one pooled
   client. If the mark already exists, the transaction rolls back and the
   message is acked as a duplicate. Mark and effect commit or vanish together.
   Putting the mark in Redis would be a dual write again.
3. **API edge.** `Idempotency-Key` header on `POST /orders`. The key is claimed
   with `INSERT INTO idempotency_records … ON CONFLICT DO NOTHING` inside the
   order transaction. If another request already claimed it, this transaction
   rolls back (stock included) and the stored response is returned with
   `Idempotent-Replayed: true`. Concurrent requests serialize on the unique key.
   The key identifies the **intent**. The body hash is stored only to reject
   reuse of one key for a different body (422). Two identical orders with
   different keys are two orders.

### Demos and numbers from my runs

All three reset their own state first: run migrations, upsert a demo user and
product (id 9001), delete that user's orders, truncate `outbox`,
`processed_messages`, `order_confirmations`, and recreate the queues. Each
prints `key=number` and exits non-zero when its invariant breaks.

| Demo | What happens | Output |
| --- | --- | --- |
| `demo:outbox` | Boots the Nest app, sends two **concurrent** `POST /orders` with the same `Idempotency-Key`, relays, consumes | `requests=2` `same-order=1` `replayed=1` `orders=1` `outbox=1` `published=1` `deliveries=1` `effect=1` `processed=1` |
| `demo:crash-write` | The order transaction throws right after the outbox insert (the row was visible inside the tx: `outbox-in-tx=1`) | `write-failed=1` `orders=0` `outbox=0` `published=0` `deliveries=0` `effect=0` `stock-unchanged=1` |
| `demo:crash-relay` | A child relay process is killed between broker confirm and `UPDATE published_at`; a second relay runs | `relay-killed=1` `unpublished-after-crash=1` `published=2` `deliveries=2` `applied=1` `skipped=1` `effect=1` `processed=1` `outbox-published=1` |

**How the relay is killed.** `demo:crash-relay` spawns `relay-main.js` as a real
child process with `RELAY_CRASH_AFTER_PUBLISH=1`. After `waitForConfirms()`
succeeds and before the `UPDATE`, the child sends itself `SIGKILL`, the same as
`kill -9`. No `finally`, no `ROLLBACK`. The OS closes the socket, Postgres
aborts the transaction and releases the row lock, and `published_at` stays NULL.
The parent waits until the dead relay's lock is gone (`SKIP LOCKED` skips it
until then), then relays again.

### At-least-once, not exactly-once

`demo:crash-relay` is the proof. The same event was delivered twice
(`deliveries=2`), and the effect happened once (`applied=1`, `effect=1`). Delivery
is **at-least-once**: exactly-once delivery between a database and a broker
does not exist (the two generals problem). The exactly-once **result** comes
from the consumer's inbox + natural key, not from RabbitMQ.

### Why publish and `UPDATE published_at` cannot be swapped

If the relay marked the row first and then crashed (or publish failed), the
row would say "published" while the broker never got it: a **lost** event that
nothing will ever retry. With publish first, the worst case is a crash before
the mark, so the event is published **again**. The choice is between a duplicate
and a loss. A duplicate is fixed by dedup on the consumer; a loss is fixed by
nothing. Also, a publish error does not prove the message was not delivered
(the confirm may be what got lost), which is another reason the consumer dedups
no matter how careful the relay is.

### Notes

- **Ordering.** `ORDER BY created_at, id` only orders the *selection*. With
  `SKIP LOCKED` and several relays, delivery order is not guaranteed, and this
  project does not need it. If it did, ordering would only exist per partition
  key (`aggregate_id`). The relay selects by `published_at IS NULL`, not by an
  id cursor: an id is assigned at insert, the row becomes visible at COMMIT,
  so an id cursor skips rows.
- **One client per transaction.** The business op uses `dataSource.transaction`;
  relay and consumer use `pool.connect()`. Never `pool.query('BEGIN')`.
- **Outbox cleanup.** Published rows are dead weight for the partial index
  scan. Production plan: a periodic
  `DELETE FROM outbox WHERE published_at < now() - interval '7 days'`, or
  partitioning by `created_at` and dropping old partitions. The same applies
  to `processed_messages`, with a retention longer than any possible redelivery.
- **Relay holds the row lock while publishing.** That is what makes a second
  relay skip in-flight rows. The cost is a transaction open across a network
  call, bounded by the batch size (`RELAY_BATCH_SIZE = 50`).
- Running it outside demos: `npm run consumer` (declares topology, consumes)
  and `npm run relay` (polls every 500 ms). The relay never declares topology.

## Grading

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export SKIP_VAULT=1
npm ci
npm run demo:outbox
npm run demo:crash-write
npm run demo:crash-relay
```

Each demo compiles first (`predemo:*` runs `tsc`) and applies pending
migrations itself, so no separate `build`/`migrate` step is required.
`5432` is PgBouncer (transaction pooling) in front of Postgres; `5672` is AMQP
(`15672` is only the management UI).
