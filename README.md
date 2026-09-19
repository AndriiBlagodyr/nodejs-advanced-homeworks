# HW-15 — PgBouncer + backup + restore-drill

PgBouncer in front of Postgres, a backup script with date-stamped dumps, and an
automated restore-drill that proves recoverability. Built on the TypeORM layer
from HW-13 and transactional checkout from HW-14.

Previous snapshots: `hw-03/`, `hw-05/`, `hw-09/`, `hw-11/`, `hw-12/`, `hw-13/`, `hw-14/`.

## Commands

```bash
npm ci
npm run build
npm run migrate
npm run seed
bash scripts/backup.sh
bash scripts/restore-drill.sh
```

## Data layer ops

### PgBouncer

The application connects through PgBouncer (port 5432), not directly to
Postgres (port 5433). PgBouncer config lives in `pgbouncer/pgbouncer.ini`.

**Why transaction mode.** `pool_mode = transaction` returns connections to the
pool after each transaction, so a small pool (10) can serve many clients (200+).
This is the right default for web workloads where most time is spent outside
the database. Transaction mode breaks three things:

1. **Prepared statements** — a statement prepared on connection A may execute on
   connection B after re-pooling. PgBouncer ≥ 1.21 mitigates this with
   `max_prepared_statements` (set to 200 in our config).
2. **Session-level state** — `SET`, advisory locks, `LISTEN/NOTIFY`, and temp
   tables are lost when the connection returns to the pool.
3. **Multi-statement transactions that rely on session context** — `DISCARD ALL`
   or `RESET ALL` between transactions can collide with the pooler.

### Backup

`scripts/backup.sh` runs `pg_dump -Fc` into `backups/<db>_<date>.dump`. The
`backup.cron` file schedules it nightly at 02:00.

### Restore drill

`scripts/restore-drill.sh` spins up a fresh Postgres container, restores the
latest dump, compares `count(*) || sum(total_cents)` on `orders`, and prints
`MATCH`. The drill container and volume are cleaned up automatically.

Full drill protocol is in [`RESTORE-DRILL.md`](./RESTORE-DRILL.md).

## Grading

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci
npm run build
npm run migrate
npm run seed

bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```
