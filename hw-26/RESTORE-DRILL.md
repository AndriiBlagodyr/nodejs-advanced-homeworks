# Restore Drill Protocol

## Drill

| Field | Value |
| --- | --- |
| Date | 2026-09-18 |
| Dump file | `backups/marketplace_2026-09-18_123646.dump` |
| Dump size | 20 KB |
| Restore time | < 1 second |
| Control (sidecar) | `8|105400` (8 orders, sum total_cents = 105 400) |
| Control (after) | `8|105400` |
| Result | **MATCH** |

## RTO

**RTO (measured): ~3 seconds.** Container start-up (~2 s) + restore (< 1 s) +
control query. On a production dataset the restore step dominates; for the
current seed-size database, container start-up is the bottleneck.

## RPO

**RPO (calculated): up to 24 hours.** The `backup.cron` schedule runs nightly at
02:00. In the worst case, a failure occurs at 01:59 the next day — 23 h 59 min
of transactions since the last successful backup are lost. WAL archiving or
streaming replication would reduce RPO to near-zero, but is outside the scope
of this homework.
