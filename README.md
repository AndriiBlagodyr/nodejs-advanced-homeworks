# HW-12 — Marketplace PostgreSQL data layer

This homework defines and measures the relational foundation of the Marketplace
API. The main table is **`orders`**, seeded with **120,000 rows**.

Previous snapshots are archived in [`hw-03/`](./hw-03),
[`hw-05/`](./hw-05), [`hw-09/`](./hw-09), and [`hw-11/`](./hw-11).

## Fresh-clone access

One line to start the database:

```bash
mkdir -p secrets && cp secrets/db_password.example secrets/db_password && docker compose up -d --wait
```

One line to connect and verify it:

```bash
docker compose exec -T db psql -U app -d marketplace -Atc "SELECT 1"
```

Both commands work on a fresh clone without editing a file. The committed
`.example` password is a local development credential, not a production
secret.

## Configuration

| Variable | Value | Source |
| --- | --- | --- |
| `DB_URL` | `postgresql://app@localhost:5432/marketplace` | HW-11 configuration store; `.env.example` is only its tracked contract |
| Database password | file `secrets/db_password` | HW-11 file-secret store, initialized from tracked `secrets/db_password.example` for the local grader stand |

No real `.env` or `secrets/db_password` file is tracked. The application
connection URL remains `DB_URL`; no second connection variable was introduced.

## Apply schema and seed

The following is the complete clean-database workflow used to produce the
optimization report:

```bash
docker compose down -v
docker compose up -d --wait
docker compose exec -T db psql -U app -d marketplace -v ON_ERROR_STOP=1 -f - < db/schema.sql
docker compose exec -T db psql -U app -d marketplace -v ON_ERROR_STOP=1 -f - < db/seed.sql
```

Verify the schema and main-table volume:

```bash
docker compose exec -T db psql -U app -d marketplace -Atc "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public';"
docker compose exec -T db psql -U app -d marketplace -Atc "SELECT count(*) FROM orders;"
```

Expected output is at least `3` foreign keys and at least `100000` orders. This
seed produces `4` foreign keys and `120000` orders.

## Explain before indexes

Run these commands after schema and seed, but before `db/indexes.sql`. Every
plan contains `Seq Scan` or `Parallel Seq Scan`.

```bash
docker compose exec -T db psql -U app -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q1.sql)"
docker compose exec -T db psql -U app -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q2.sql)"
docker compose exec -T db psql -U app -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q3.sql)"
```

The queries represent:

1. A user's order history for a date range.
2. The pending-order fulfillment queue.
3. Case-insensitive regional completed-order search.

## Apply indexes and explain again

```bash
docker compose exec -T db psql -U app -d marketplace -v ON_ERROR_STOP=1 -f - < db/indexes.sql
docker compose exec -T db psql -U app -d marketplace -c "ANALYZE;"
docker compose exec -T db psql -U app -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q1.sql)"
docker compose exec -T db psql -U app -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q2.sql)"
docker compose exec -T db psql -U app -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q3.sql)"
```

All three plans now use `Index Scan` or `Index Only Scan` and contain no
sequential scan. The measured plans and explanations are in
[`db/OPTIMIZATIONS.md`](./db/OPTIMIZATIONS.md).

Verify that PostgreSQL installed partial or expression indexes:

```bash
docker compose exec -T db psql -U app -d marketplace -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND (indexdef ILIKE '% WHERE %' OR indexdef ~ '\((\w+)\(');"
```

Expected output: `2`.

## Files

- `db/schema.sql` — five domain tables, constraints, and four foreign keys.
- `db/seed.sql` — skewed users/products/orders data and `VACUUM (ANALYZE)`.
- `db/queries/q1.sql`–`q3.sql` — one API-shaped statement per file.
- `db/indexes.sql` — three query-driven indexes, including partial and
  expression indexes.
- `db/OPTIMIZATIONS.md` — full before/after execution plans.
- `docker-compose.yml` — PostgreSQL 17 grader stand.
