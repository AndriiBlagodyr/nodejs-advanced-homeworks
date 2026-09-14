# HW-13 — TypeORM data layer

Marketplace schema from [HW-12](./hw-12) is now a TypeORM data layer: entities,
relations, migrations (`synchronize: false`), an idempotent seed, an N+1 demo,
and a QueryBuilder report. Connection settings come from `process.env`, which
`scripts/with-secrets.sh` fills via Infisical. Previous homework snapshots live
in `hw-03/`, `hw-05/`, `hw-09/`, `hw-11/`, and `hw-12/`.

## Commands

```bash
npm ci
npm run build
npm run migrate
npm run migrate:show
npm run seed
npm run demo:nplus1
npm run report
```

`synchronize` is set to `false` in `src/data-source.ts`. Schema changes go
through `src/migrations/` only.

## Seed row counts

After `npm run seed` (and again after a second run) the counts stay:

```bash
docker compose exec -T db psql -U app -d marketplace -c \
  "SELECT
     (SELECT count(*) FROM users) AS users,
     (SELECT count(*) FROM products) AS products,
     (SELECT count(*) FROM orders) AS orders,
     (SELECT count(*) FROM order_items) AS order_items,
     (SELECT count(*) FROM idempotency_records) AS idempotency_records;"
```

Expected: `users=8`, `products=8`, `orders=8`, `order_items=12`,
`idempotency_records=5`.

## N+1 (order → items → product)

Measured by `npm run demo:nplus1` (optional `N` via argv, default `8`):

```bash
npm run demo:nplus1 -- 8
npm run demo:nplus1 -- 16   # after seeding enough orders; join/query counts stay flat
```

All three strategies load the **same** order ids from `find({ take: N, order: { id: 'ASC' } })`.
The naive path then loads items per order and the product per item. The fix uses
`leftJoinAndSelect`. `relationLoadStrategy: 'query'` is the two-level query
strategy from the assignment (1 + 2 × levels).

| Strategy | SQL queries (N=8) |
| --- | ---: |
| naive (query in a loop) | 21 |
| `leftJoinAndSelect` | 1 |
| `relationLoadStrategy: 'query'` | 4 |

21 ≥ N. The join fix is 1 and does not grow with N. The query strategy is a
small constant (4, within `1 + 2 × 2 = 5` for two relation levels) and also
independent of N.

## Repository vs QueryBuilder

`Repository.find()` is for loading an entity graph you already modeled:
filters, relations, pagination. It is the default for “give me these orders
with their items.” QueryBuilder is for reports: `JOIN` + `GROUP BY` +
aggregates (`SUM`, `COUNT`) that do not map to a single entity. `npm run report`
is revenue by `shipping_country` — `find()` cannot express that without loading
every row into memory.

## onDelete

- `Order.user` and `OrderItem.product` use `RESTRICT`: deleting a user or a
  product must not erase order history.
- `OrderItem.order` and `IdempotencyRecord.order` use `CASCADE`: line items and
  the idempotency row are owned by the order and go with it.

Covering indexes (`INCLUDE`, `DESC`) are created only in the migration. On
`Order` they are declared as `@Index('…', { synchronize: false })` so a later
`migration:generate` does not emit a false DROP/CREATE.

## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=app DB_PASSWORD=marketplace_dev_password DB_NAME=marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища
```
