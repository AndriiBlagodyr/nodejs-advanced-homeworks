# Restore Drill Protocol

## Drill

| Field | Value |
| --- | --- |
| Date | 2026-09-17 |
| Dump file | `backups/marketplace_2026-09-17_093530.dump` |
| Dump size | 20 KB |
| Restore time | < 1 second |
| Control (before) | `8\|105400` (8 orders, sum total_cents = 105400) |
| Control (after) | `8\|105400` |
| Result | **MATCH** |

## RTO

**RTO (measured): ~5 seconds.** This includes spinning up a fresh Postgres
container (~3 s), restoring the dump (< 1 s), and running the control query.
On a production system with a larger dataset, the restore step dominates; for
the current seed-size database, the container start-up is the bottleneck.

## RPO

**RPO (calculated): up to 24 hours.** The `backup.cron` schedule runs nightly at
02:00. In the worst case, a failure occurs at 01:59 the next day — 23 hours and
59 minutes of transactions since the last successful backup are lost. WAL
archiving or streaming replication would reduce RPO to near-zero, but is outside
the scope of this homework.
