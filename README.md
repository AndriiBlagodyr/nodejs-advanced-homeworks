# HW-24 — Auth: access tokens, refresh rotation, 401 vs 403

`POST /orders` no longer accepts a caller-supplied user. Login gives an ES256
access token and an opaque refresh token. The access token answers "who is
this?". A role or an order's owner answers "are they allowed?", and that
answer is not in the signature.

Previous snapshots: `hw-03/` … `hw-16/`, `hw-18/`, `hw-19/`, `hw-22/`, `hw-23/`.

## Auth

### What I chose

**ES256 (P-256).** OWASP marks RS256 as "not recommended" and points at ES256,
PS256 or EdDSA. P-256 is in `node:crypto`, the keys and signatures are short,
and verification passes an explicit allowlist `algorithms: ['ES256']`
(RFC 8725 §3.1). A token cannot switch itself to `HS256` or `none`. There is
no shared HMAC secret, so the process that verifies tokens cannot sign itself
a `role: admin`.

**Refresh tokens are random 32-byte strings, not JWTs.** The table stores
`HMAC-SHA256(pepper, token)`, never the token. The pepper is `REFRESH_TOKEN_PEPPER`
from the vault. A dump of the table is not a dump of live sessions.

**The denylist is in Postgres, next to the refresh family, in one transaction.**
Redis from HW-23 is still the cache, the session store, the rate limiter and
the queue. It is not the denylist: writing `revoked_at` in Postgres and the
denylist in Redis would be the dual write from HW-22, and logout would not be
one COMMIT. The grader also does not set `REDIS_URL`. A denylist row stops
matching at the access token's `exp`, and the next logout deletes expired rows,
so the table does not grow.

### Variables

| Змінна | Джерело | Навіщо |
| --- | --- | --- |
| `JWT_PRIVATE_KEY` | сховище (#11) | base64 PKCS#8 PEM, signs access tokens |
| `JWT_PUBLIC_KEY` | сховище (#11) | base64 SPKI PEM of the current `kid` |
| `JWT_KID` | сховище (#11) | `kid` header; the verifier picks the key by it |
| `JWT_PUBLIC_KEYS` | сховище (#11) | optional JSON `{"old-kid":"<base64 PEM>"}` kept during overlap |
| `REFRESH_TOKEN_PEPPER` | сховище (#11) | HMAC pepper for refresh-token hashes |
| `DATABASE_URL` | compose / оточення | dev credentials, not a secret |
| `REDIS_URL` | compose / оточення | cache (`allkeys-lru`) |
| `REDIS_QUEUE_URL` | compose / оточення | queue, sessions, rate limits (`noeviction`) |

`npm run start` is a bare `node dist/src/main.js`. It checks these four required
secrets before Nest opens a database connection, and exits non-zero naming
whatever is missing. There is no default. It also rejects a key that is not
EC P-256, and a private/public pair that does not match (it signs a probe and
verifies it). A mismatched pair would otherwise boot and answer 401 to
everyone. `npm run start:vault` and
`demo:auth`, `demo:reuse`, `demo:rbac` go through `scripts/with-secrets.sh`.

### Login, rotation, reuse

`POST /auth/login` checks the password (scrypt) and reads `users.role` from
the database. It returns an access token (10 minutes: `sub`, `role`, `jti`,
`fid`, `kid`) and a refresh token (30 days) in a new `family_id`.

`POST /auth/refresh` locks that row (`FOR UPDATE`) and, in the same
transaction, marks it used and inserts the next token of the same family.
The new access token's role is read from `users` again, not copied out of the
old token.

If the presented refresh token already has `used_at`, that is the theft
signal from RFC 9700 §4.14.2. The transaction sets `revoked_at` on every row
of the family and the log line is `refresh token reuse; family revoked
family_id=…` (the id only, never the token). Both the thief and the honest
client are out. Rotation without the family would leave the honest client's
new token alive. Access tokens already issued in that family are not
denylisted: they live until `exp`, at most 10 minutes. That is the access TTL
doing its job.

There is no grace window. The client serializes refresh: one in-flight promise
for everyone. A window that handed back the same new pair would make an
immediate second presentation look successful, and a parallel refresh of one
token is treated as theft. That is the tradeoff, and it is why `r1-reuse` is
401 with no delay.

### Why logout is two actions

The refresh token is a row. Logout sets `revoked_at` on its family, and that
is enough for it. The access token is self-contained and valid until `exp`, so
logout also inserts its `jti` into `access_denylist` with `expires_at` equal
to that `exp`. Both writes are the same COMMIT. `after-logout=401` is the
denylist; `refresh-after-logout=401` is the family. Either one alone leaves a
usable credential.

### 401, 403, and where ownership is checked

No token, a bad signature, an expired token, or a denylisted `jti` is **401**.
A valid token with the wrong role is **403** (`RolesGuard` on `POST /products`:
`seller` and `admin` only). A client refreshes on 401 and shows an error on
403. Swapping them either loops on refresh or logs the user out on every
foreign page.

Ownership is not a guard. `AuthGuard` runs before the order is loaded and does
not know `user_id`. `GET /orders/:id` loads the row in `OrdersService.findOneForViewer`
and then compares `order.userId` to `sub`. A missing order is 404. Someone
else's order is 403. A `WHERE user_id = $me` would hide the row and answer
404, which is not what this check is for. The guard authenticates. The service,
which already has the row, authorizes.

In this domain, orders are the owned resource and products are the privileged
write. The same boundary covers every way into an order:

- `GET /orders` is a list, so there the filter *is* `WHERE user_id = $me`.
  An admin sees all orders.
- `PATCH /orders/:id/status`: the owner may only set `cancelled`, and any
  other status is 403. An admin may set any status.
- SSE `GET /orders/:id/events` and the WebSocket `join` authenticate with the
  same access token. The WebSocket token goes in the handshake as
  `auth.token`. SSE takes the `Authorization` header, or `?access_token=` because
  `EventSource` cannot set headers. Then they call the same
  `OrdersService.requireOwner`. The old `x-user-id` and `userId` in the message
  body are gone. `scripts/realtime-demo.mjs` needs `ACCESS_TOKEN`.
- `POST /session` (HW-23) is behind `AuthGuard` and takes the user from `sub`.

Seed users have no password, so they cannot log in. Demos and tests create
their own users.

### The role in the token is a cache

`users.role` is read at login and at refresh. It is not read on every request.
Demote an admin and their current access token still says `admin` until `exp`,
at most 10 minutes. The next refresh picks up the new role. That window is the
price of not hitting the database on every call. It is not a surprise, and it
is not fixed by a longer denylist.

### Overlap rotation and `kid`

A new key signs new tokens: `JWT_KID` plus `JWT_PRIVATE_KEY`. While old access
tokens are still inside their 10 minutes, `JWT_PUBLIC_KEYS` keeps the previous
public key under its own `kid`. The verifier looks up `header.kid` and does
not try every key. Without `kid` there is no overlap, because the verifier
would not know which key signed the token. When the old tokens have expired,
drop the old `kid`. Startup logs `auth signing kid=… fingerprint=…` and never
the key.

The fingerprint is SHA-256 of the SPKI DER, first 16 hex characters. Dev and
prod are different keys:

| Environment | kid | fingerprint |
| --- | --- | --- |
| dev | `dev-2026-10` | `cc5b95404c60a21a` |
| prod | `prod-2026-10` | `3a78e84114c26196` |

The private keys are not in the repo. They are in `secrets/auth-dev.env` and
`secrets/auth-prod.env` (gitignored) to be copied into the vault. `secrets/auth.env.example`
shows the names only.

### Demos, from my runs

```text
$ npm run demo:auth
login=200  no-token=401  with-token=200  refresh=200
logout=204  after-logout=401  refresh-after-logout=401

$ npm run demo:reuse
login=200  r1-refresh=200  r1-reuse=401  r2-after-reuse=401

$ npm run demo:rbac
anon=401  own=200  foreign=403
role-denied=403  role-allowed=201  tampered=401
```

`tampered` is the same access token with `role` rewritten to `admin` and the
old signature left in place. No signing key is used to build it. A verifier
that only decoded the payload would return 201 here.

The same invariants run in `npm run test:e2e` (`Auth E2E`): family revocation
on reuse, logout killing both tokens, 401/403/200 on an order, the list
scoped to the caller, a buyer cancelling but not completing, and the role
check on products. Tests and the HW-22/23 demos that do not exercise auth
get a throwaway key pair from `src/demos/ephemeral-auth.ts`, and only when
the variables are unset. `main.ts` never generates keys.

---

# HW-23 — Redis: cache, sessions, rate limits, queue

Redis takes four jobs in the Marketplace: a cache for the product card, the
session store, a shared rate limiter, and a BullMQ queue for receipts and the
outbox retention sweep. Postgres stays the source of truth for everything.

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
  expired and was taken by someone else. Losers poll the key every 25 ms **for
  as long as the lock exists**. There's no separate wall-clock timeout, because
  a timeout shorter than the lock TTL would send every waiter to the DB on a
  slow read. If the lock disappears without a value (holder crashed, load
  failed, or 5 s passed), the next `SET NX` elects exactly one new loader.
- **Redis down = slower, not broken:** a failed read goes straight to the DB, a
  failed write is ignored. Redis is never the source of truth.
- **Stale stock is accepted:** stock on the card can lag by up to one TTL.
  Checkout re-checks stock in Postgres under a lock, so a stale card can show
  a wrong number but can't oversell.

### 2. Sessions with rolling TTL

`POST /session` creates a random 32-byte `sid` (cookie `sid`, `HttpOnly`,
`SameSite=Lax`, `Secure`) and a hash `session:{sha256(sid)}` (the raw token is never a
key). Every request with the cookie runs one Lua script: `EXISTS` → `HINCRBY
requests` → `HSET lastSeenAt` → `PEXPIRE 30 min` → `HGETALL`. The TTL is pushed
forward atomically, and an expired session is never resurrected. Login rotates
the session; `DELETE /session` deletes the key.

`Secure` is left out only for plain HTTP to `localhost` / `127.0.0.1` / `::1`
(the local stand). Behind a TLS-terminating proxy the app sees
`X-Forwarded-Proto: https` from a trusted hop and sets `Secure`. Plain HTTP to
any other host also gets `Secure`, so the browser won't send `sid` over an
unencrypted connection.

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
share it.

`{ip}` is `req.ip`, which depends on Express `trust proxy` (set in
`src/configure-app.ts`). Without it, behind an ingress every client has the
proxy's address and shares one window. With `true`, any client could forge
`X-Forwarded-For` and get a fresh window per request. The default is
`loopback, linklocal, uniquelocal`, so `X-Forwarded-For` is trusted only from
proxies on private networks. `TRUST_PROXY` overrides it (hop count, `true`/`false`,
or a list of subnets) for setups where the proxy has a public address.

If Redis is down the guard fails open (logs and lets the request
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
warmed=60  ttl-distinct=36  ttl-min=300  ttl-max=360
concurrent=50  all-served=1  db-calls=1  lock-left=0
slow-load-ms=3500  slow-db-calls=1  slow-all-served=1
warm-reads=100  db-calls-warm=0

$ npm run demo:session
requests=3  sessions=1  sessions-in-redis=1  in-redis=1
ttl-before-ms=1798491  ttl-after-ms=1799996  ttl-renewed=1
survived-restart=1  server-requests=3
cookie-secure-local=0  cookie-secure-behind-tls-proxy=1

$ npm run demo:ratelimit
instances=2  limit=5  window-ms=10000  requests=12
allowed=5  blocked=7  allowed-pod-a=3  allowed-pod-b=2
status=429  retry-after=1  retry-after-seconds=10
proxied-clients-separate=1

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
  The second stampede makes the DB read take 3.5 s (longer than a typical fixed
  wait, shorter than the 5 s lock). The 49 waiters kept waiting on the lock, and
  still only 1 query reached Postgres (`slow-db-calls=1`).
- **session:** 1.5 s pause between requests 1 and 2; PTTL went from 1798491 ms
  to 1799996 ms. Then the Nest app was closed and a new one booted, and request
  3 got the same session (`requests=3` counted server-side). The local cookie
  has no `Secure`; the same app behind `X-Forwarded-Proto: https` sets it.
- **ratelimit:** two separate Nest apps on two ports, requests alternated, limit 5
  per 10 s. Exactly 5 got through in total (3 + 2), not 5 per pod. After that
  the direct client is blocked, yet two clients coming through a trusted proxy
  (`X-Forwarded-For: 203.0.113.10` / `.11`) still got 200 each: separate windows,
  not the proxy's shared one.
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

One-time ES256 key pair and pepper for the run. The real signing key stays in
the vault; this pair lives only in a temp dir that is deleted right after it is
exported. The DB password is read from the local `db` container, so no
connection string with a password is written down here.

```bash
docker compose up -d --wait
export DATABASE_URL="postgres://app:$(docker compose exec -T db printenv POSTGRES_PASSWORD)@127.0.0.1:5432/marketplace"
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export REDIS_URL=redis://127.0.0.1:6390
export REDIS_QUEUE_URL=redis://127.0.0.1:6391
export SKIP_VAULT=1
KEYS="$(mktemp -d)"
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs"), dir=process.argv[1];
fs.writeFileSync(dir+"/priv.b64",Buffer.from(k.privateKey).toString("base64"),{mode:0o600});
fs.writeFileSync(dir+"/pub.b64",Buffer.from(k.publicKey).toString("base64"));' "$KEYS"
export JWT_KID=grader
export JWT_PRIVATE_KEY="$(cat "$KEYS/priv.b64")"
export JWT_PUBLIC_KEY="$(cat "$KEYS/pub.b64")"
export REFRESH_TOKEN_PEPPER="$(openssl rand -hex 32)"
rm -rf "$KEYS"
npm ci
npm run demo:auth
npm run demo:reuse
npm run demo:rbac
```

Each demo compiles first (`predemo:*` runs `tsc`) and applies pending
migrations itself. `5432` is PgBouncer in front of Postgres. `5672` is AMQP.
`6390` is the cache Redis and `6391` the queue Redis, still used by the HW-23
demos (`demo:cache`, `demo:session`, `demo:ratelimit`, `demo:queue`) and the
HW-22 ones (`demo:outbox`, `demo:crash-write`, `demo:crash-relay`). None of
the ports are in 22300–22399. `npm run start` without the four secrets exits
non-zero and names the missing variable; it does not open the database first.
