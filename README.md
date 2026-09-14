# HW-14 — Concurrent checkout & workers

Transactional checkout on top of the TypeORM layer from
[HW-13](./hw-13): stock decrement, balance debit, order insert, and a
post-processing job — all in one transaction. Plus a `FOR UPDATE SKIP LOCKED`
worker pool and a serialization-failure retry wrapper.

Previous snapshots: `hw-03/`, `hw-05/`, `hw-09/`, `hw-11/`, `hw-12/`, `hw-13/`.

## Commands

```bash
npm ci
npm run build
npm run migrate
npm run seed
npm run demo:race
npm run demo:workers
npm run demo:retry
```

`synchronize` stays `false`. Schema changes go through `src/migrations/` only.
DB scripts (including the three new demos) are wrapped with
`bash scripts/with-secrets.sh dev …`.

## Конкурентність

### Checkout protection

Checkout uses an **atomic** `UPDATE … SET stock = stock - $n WHERE … AND stock >= $n RETURNING`.
Zero rows means “no stock” and there is no race window between check and write —
unlike a JS read-modify-write or a separate `SELECT … FOR UPDATE` followed by an
update in application code. Balance is decremented the same way. Any failure
rolls the whole transaction back, so orphan orders cannot appear.

### Numbers from local runs

| Demo | Result |
| --- | --- |
| `demo:race` | 50 attempts, **10** successes, final stock **0**, negative stock rows **0** |
| `demo:workers` | 20 jobs / 4 workers, **processed twice: 0**, elapsed ~319–480 ms vs sequential estimate 800 ms |
| `demo:retry` | ≥ 1 caught `40001` (often ~20+ events), final balance `100 - 8 = 92` |

Retry catches **only** Postgres `40001` (serialization_failure) and `40P01`
(deadlock_detected). Other errors (check violations, insufficient stock, bugs)
must surface immediately — blind retries would hide real failures or amplify
them. The whole transaction (including the reads) is re-run from scratch.

## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=app DB_PASSWORD=marketplace_dev_password DB_NAME=marketplace
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища
```
