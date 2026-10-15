# HW-23 — Redis: cache, sessions, rate limits, queue

Redis takes four jobs in the Marketplace: a cache for the product card, the
session store, a shared rate limiter, and a BullMQ queue for receipts and the
outbox retention sweep. Postgres stays the source of truth for everything.

Previous snapshots: `hw-03/` … `hw-16/`, `hw-18/`, `hw-19/`, `hw-22/`
(transactional outbox; still running here, see the second half of this file).

## Redis: кеш, сесії, ліміти, черга

### Pieces

| Piece | Where |
| --- | --- |
| Two Redis clients (cache / state+queue), fail-fast options | `src/redis/clients.ts` |
| Lock: `SET lock:… token NX PX`, Lua compare-and-delete release | `src/redis/lock.ts` |
| Cache-aside + single-flight + TTL jitter + negative cache | `src/redis/single-flight-cache.ts` |
| Heavy read: product card with sales aggregates, `GET /products/:id/card` | `src/products/product-card.ts`, `product-card.controller.ts` |
| Sessions with rolling TTL, `POST/GET/DELETE /session` | `src/session/*` |
| Sliding-window limiter (one Lua script), Nest guard with 429 + `Retry-After` | `src/rate-limit/*` |
| BullMQ queue `receipts`: `send-receipt` jobs + `outbox-purge` scheduler | `src/queue/receipts.queue.ts`, worker `src/queue/worker-main.ts` |
| Demos | `src/demos/demo-{cache,session,ratelimit,queue}.ts` |

The Redis module is loaded only when both `REDIS_URL` and `REDIS_QUEUE_URL`
are set, so integration/e2e/contract tests keep running without Redis.

### Two instances, and why

| | `redis-cache` (`:6390`) | `redis-queue` (`:6391`) |
| --- | --- | --- |
| Policy | `maxmemory 64mb`, `allkeys-lru` | `maxmemory 256mb`, `noeviction` |
| Persistence | none (`--save ""`, no AOF) | AOF, `appendfsync everysec`, volume `redis_queue_data` |
| Holds | `product:card:*`, `lock:product:card:*` | BullMQ `bull:*`, `session:*`, `rl:*` |

**Why two:** a cache must be allowed to evict under memory pressure, while
eviction in a queue silently deletes jobs (and BullMQ's own locks), so one
instance cannot have both policies. With `noeviction` a full queue Redis fails
writes loudly instead of losing data.

**Sessions live in the queue instance**, not the cache one: under `allkeys-lru`
a busy cache would log users out by evicting their sessions, and the cache has
no persistence, so a Redis restart would drop every session. The `noeviction`
+ AOF instance keeps them across restarts of both the app and Redis. Rate-limit
counters sit there too: evicting a counter would reset someone's limit.

### 1. Cache-aside on the product card

`GET /products/:id/card` returns the product plus `units_sold`,
`orders_count`, `revenue_cents`, `last_ordered_at`: an aggregate over
`order_items` ⋈ `orders`. That's the heavy read. Key `product:card:{id}`.

- **TTL always, with jitter:** `300 + random(0..60)` s (negative results
  `30 + random(0..15)` s, so a hammered non-existent id does not hit the DB on every request).
- **Single-flight:** on a miss, `SET lock:product:card:{id} <uuid> NX PX 5000`.
  The winner re-checks the cache, reads the DB, writes the value, and releases
  the lock with a Lua `GET == token → DEL` so it never deletes a lock that
  expired and was taken by someone else. Losers poll the key every 25 ms for up
  to 3 s, then fall back to reading the DB themselves.
- **Redis down = slower, not broken:** a failed read goes straight to the DB, a
  failed write is ignored. Redis is never the source of truth.
- **Stale stock is accepted:** stock on the card can lag by up to one TTL.
  Checkout re-checks stock in Postgres under a lock, so a stale card can show
  a wrong number but can't oversell.

### 2. Sessions with rolling TTL

`POST /session` creates a random 32-byte `sid` (cookie `sid`, `HttpOnly`,
`SameSite=Lax`) and a hash `session:{sha256(sid)}` (the raw token is never a
key). Every request with the cookie runs one Lua script: `EXISTS` → `HINCRBY
requests` → `HSET lastSeenAt` → `PEXPIRE 30 min` → `HGETALL`. The TTL is pushed
forward atomically, and an expired session is never resurrected. Login rotates
the session; `DELETE /session` deletes the key.

### 3. Rate limit: sliding window log

**Model:** sliding window log. Of the models I looked at, it's the only one
with no boundary burst: a fixed window lets `2 × limit` through around the edge
of the window. The cost is one sorted-set entry per request, which is fine at
60 req/min.

One Lua script per request: `TIME` (Redis clock, so pods' clocks don't matter)
→ `ZREMRANGEBYSCORE` old entries → `ZCARD` → `ZADD` if under the limit →
`PEXPIRE`. When blocked, it returns how long until the oldest entry leaves the
window. The guard answers `429` with `Retry-After` (seconds, at least 1) plus
`RateLimit-Limit` / `RateLimit-Remaining`. Key `rl:{route}:{ip}`, so all pods
share it. If Redis is down the guard fails open (logs and lets the request
through) because the limiter protects the DB, it isn't a security boundary.
Config: `RATE_LIMIT_LIMIT` (60) and `RATE_LIMIT_WINDOW_MS` (60000).

### 4. BullMQ queue `receipts`

- **Producer:** the HW-22 `order.placed` consumer, after the effect commits and
  before ack, adds `send-receipt` with `jobId = receipt-{orderId}`. A redelivered
  event adds the same jobId, so BullMQ keeps one job. If Redis is unavailable
  the message is requeued like a transient DB error.
- **Options:** `attempts: 5`, `backoff: { type: 'exponential', delay: 1000,
  jitter: 0.5 }`, `removeOnComplete: { age: 86400, count: 10000 }` (not
  `true`: a completed job must stay long enough to dedup a late duplicate),
  `removeOnFail: { age: 7 days }`.
- **Scheduler:** `queue.upsertJobScheduler('outbox-purge', { every: 10 min })`.
  It replaces the `setInterval` the HW-22 relay used for retention. Upsert is
  idempotent, so every worker start (or several workers) still leaves one
  scheduler. `npm run worker` runs it.
- Worker connection uses `maxRetriesPerRequest: null` (BullMQ requirement);
  producer connections fail fast so an HTTP request or consumer never hangs on Redis.

### Demos and numbers from my runs

Each demo resets only its own keys (`SCAN`, never `KEYS`), prints
`key=number`, and ends with `invariant-ok=1`, or exits 1 if a check fails.

```text
$ npm run demo:cache
cache-lru=1  cache-maxmemory=1  cache-maxmemory-mb=64
warmed=60  ttl-distinct=35  ttl-min=303  ttl-max=360
concurrent=50  all-served=1  db-calls=1  lock-left=0
warm-reads=100  db-calls-warm=0

$ npm run demo:session
requests=3  sessions=1  sessions-in-redis=1  in-redis=1
ttl-before-ms=1798492  ttl-after-ms=1799995  ttl-renewed=1
survived-restart=1  server-requests=3

$ npm run demo:ratelimit
instances=2  limit=5  window-ms=10000  requests=12
allowed=5  blocked=7  allowed-pod-a=3  allowed-pod-b=2
status=429  retry-after=1  retry-after-seconds=10

$ npm run demo:queue
queue-noeviction=1  attempts=3  fail-times=2  completed=1
added=2  queued=1  same-job-id=1  readd-after-complete-deduped=1
schedulers=1  scheduler-upserts=2  scheduled-runs=7
```

(Each value prints on its own line; they're grouped here to save space.)

- **cache:** `cache-lru` / `cache-maxmemory` come from `CONFIG GET` on the cache
  connection at runtime. `db-calls` is counted at the driver by a TypeORM
  logger that matches the `/* product-card */` SQL tag. Out of 50 concurrent
  requests for a just-expired key, 1 reached Postgres; 100 warm reads, 0.
- **session:** 1.5 s pause between requests 1 and 2; PTTL went from 1798492 ms
  to 1799995 ms. Then the Nest app was closed and a new one booted, and request
  3 got the same session (`requests=3` counted server-side).
- **ratelimit:** two separate Nest apps on two ports, requests alternated, limit 5
  per 10 s. Exactly 5 got through in total (3 + 2), not 5 per pod.
- **queue:** queue `receipts-demo` (same code, isolated name). The job fails
  twice on purpose and succeeds on the 3rd attempt. Two adds with one jobId
  gave one job; re-adding after completion did not run it again. The scheduler
  was upserted twice (500 ms interval) and is still one; it fired 7 times in about 3 s.

### If the stampede lock breaks

The lock has a 5 s TTL. If the DB read is slower than that, or Redis loses the
lock key, two requests will both read Postgres and both write the card. The
result is a few extra reads of one aggregate and two writes of practically the
same value (last write wins, both carry a fresh TTL). That's acceptable here
because the cache is only an optimisation. No decision is made from it: stock
and prices are checked again in Postgres at checkout, so the worst case is a
short DB load spike, not a wrong order. Release by token makes sure a slow
holder never deletes someone else's lock. If the protected section ever did
writes that must not run twice, this lock would not be enough. It would need a
fencing token checked by the DB (or a real DB lock).

### Secrets

No new env files. `REDIS_URL` and `REDIS_QUEUE_URL` go into the same Infisical
project/environment (`dev`) that already holds `DATABASE_URL`. All new scripts
(`demo:cache`, `demo:session`, `demo:ratelimit`, `demo:queue`, `worker`) start
with `bash scripts/with-secrets.sh dev …`. `.env.example` only lists the
variables with local placeholders.

---

# HW-22 — Transactional outbox and idempotency

Placing an order (`POST /orders`) now tells the outside world about it without a
dual write. The order rows, the `Idempotency-Key` claim and the `order.placed`
outbox row commit in one Postgres transaction. A separate relay moves the
outbox to RabbitMQ. The consumer applies the effect idempotently.

## Outbox та ідемпотентність

### Pieces

| Piece | Where |
| --- | --- |
| Migration: `outbox`, partial index `WHERE published_at IS NULL`, `processed_messages`, `order_confirmations` | `src/migrations/1726300000000-OutboxAndInbox.ts` |
| Migration: `outbox.last_error`, retention indexes on `published_at` / `processed_at` | `src/migrations/1726400000000-OutboxRetryAndRetention.ts` |
| Retention sweep (batched `DELETE`) | `src/outbox/retention.ts`, one-shot `src/outbox/purge-main.ts` |
| Business operation: order + items + idempotency claim + outbox row in one `dataSource.transaction` | `src/orders/place-order.ts` |
| Event contract (`toOrderPlacedEvent`), not the ORM entity | `src/outbox/order-placed.event.ts` |
| Relay: `FOR UPDATE SKIP LOCKED` → publish (confirm channel) → `UPDATE published_at` | `src/outbox/relay.ts`, worker `src/outbox/relay-main.ts` |
| Idempotent consumer | `src/outbox/consumer.ts`, worker `src/outbox/consumer-main.ts` |
| Demos | `src/demos/demo-*.ts` |

The broker is RabbitMQ from `docker-compose.yml`: a separate process from
Postgres, so there really are two resource managers and no shared COMMIT.

Outbox columns follow the Debezium Outbox Event Router roles: `id`,
`aggregate_type`, `aggregate_id`, `type`, `payload jsonb`, plus `created_at`,
`published_at` (NULL = not relayed yet), `attempts` and `last_error`. Debezium's canonical
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
child process with `RELAY_CRASH_AFTER_PUBLISH=1`. After the broker confirms
the publish and before the `UPDATE`, the child sends itself `SIGKILL`, the same as
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
- **Outbox cleanup (implemented).** `purgeOutbox()` in
  `src/outbox/retention.ts` deletes published outbox rows older than 7 days
  and `processed_messages` marks older than 30 days, in batches of 1000
  (`DELETE … WHERE id IN (SELECT … LIMIT 1000)`) so a backlog never holds long
  locks. Indexes `idx_outbox_published_at` and
  `idx_processed_messages_processed_at` keep the sweep from scanning the whole
  table. Pending and parked rows (`published_at IS NULL`) are never deleted.
  Since HW-23 the sweep runs every 10 minutes as the BullMQ `outbox-purge`
  job scheduler (`npm run worker`) instead of a timer in the relay;
  `npm run outbox:purge` still runs it once. Inbox retention (30 days) is
  longer than outbox retention (7 days), so a message cannot be redelivered
  after its mark is gone. At much larger volumes the next step is to partition
  `outbox` by `created_at` and drop old partitions instead of deleting rows.
- **Relay retry limit.** Each row is confirmed by the broker separately. A
  row the broker refuses gets `attempts + 1` and `last_error`. The relay only
  selects `attempts < 5` (`RELAY_MAX_ATTEMPTS`), so after 5 failed publishes
  a poison row is **parked**: it stays in the table with its error for a
  human, and it stops blocking `drainOutbox`. Infrastructure failures (closed
  channel, DB error) roll the batch back without touching `attempts`, so a
  broker outage cannot park healthy rows.
- **Consumer retry policy.** Transient DB errors (lost connection, `08xxx`,
  deadlock, serialization failure, admin shutdown) are retried in-process 3
  times with 100/200 ms backoff. If the DB is still unavailable, the message
  goes back to the queue with `reject(requeue=true)`; RabbitMQ 4.2 quorum
  queues increment `x-delivery-count` on each requeue (checked). After 5
  redeliveries (`CONSUMER_MAX_REDELIVERIES`) it goes to the DLQ. Permanent
  errors (constraint/data errors) and malformed events go to the DLQ right
  away. A short DB blip no longer sends events to the DLQ.
- **Relay holds the row lock while publishing.** That is what makes a second
  relay skip in-flight rows. The cost is a transaction open across a network
  call, bounded by the batch size (`RELAY_BATCH_SIZE = 50`).
- Running it outside demos: `npm run consumer` (declares topology, consumes),
  `npm run relay` (polls every 500 ms), `npm run worker` (BullMQ) and
  `npm run outbox:purge` (one-shot sweep). The relay never declares topology.
  With `REDIS_QUEUE_URL` set, the consumer also enqueues `send-receipt`.

## Grading

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export REDIS_URL=redis://127.0.0.1:6390
export REDIS_QUEUE_URL=redis://127.0.0.1:6391
export SKIP_VAULT=1
npm ci
npm run demo:cache
npm run demo:session
npm run demo:ratelimit
npm run demo:queue
# HW-22, still passing:
npm run demo:outbox
npm run demo:crash-write
npm run demo:crash-relay
```

Each demo compiles first (`predemo:*` runs `tsc`) and applies pending
migrations itself, so no separate `build`/`migrate` step is required.
`5432` is PgBouncer (transaction pooling) in front of Postgres; `5672` is AMQP
(`15672` is only the management UI); `6390` is the cache Redis, `6391` the
queue/state Redis. None of the ports are in 22300–22399.
