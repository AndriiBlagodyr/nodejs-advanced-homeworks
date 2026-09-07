# Query optimization report

Environment: PostgreSQL 17.11 in Docker Desktop on Apple Silicon. The database
contained 120,000 orders and was vacuumed and analyzed before these plans were
captured.

## Q1 — order history for one user and month

### Before index

```text
Limit  (cost=3471.32..3471.33 rows=3 width=31) (actual time=8.805..8.811 rows=50 loops=1)
  Buffers: shared hit=1369
  InitPlan 1
    ->  Index Scan using users_email_key on users  (cost=0.28..8.30 rows=1 width=8) (actual time=0.010..0.011 rows=1 loops=1)
          Index Cond: (email = 'power.user@marketplace.example'::text)
          Buffers: shared hit=3
  ->  Sort  (cost=3463.02..3463.03 rows=3 width=31) (actual time=8.804..8.806 rows=50 loops=1)
        Sort Key: orders.created_at DESC
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: shared hit=1369
        ->  Seq Scan on orders  (cost=0.00..3463.00 rows=3 width=31) (actual time=0.017..7.690 rows=10000 loops=1)
              Filter: ((created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone) AND (user_id = (InitPlan 1).col1))
              Rows Removed by Filter: 110000
              Buffers: shared hit=1366
Planning:
  Buffers: shared hit=160
Planning Time: 0.418 ms
Execution Time: 8.848 ms
```

Without an orders index, PostgreSQL scanned all 120,000 orders and sorted the
10,000 matches, touching 1,369 shared buffers.

### After index

```text
Limit  (cost=8.72..12.79 rows=3 width=31) (actual time=0.040..0.047 rows=50 loops=1)
  Buffers: shared hit=4 read=3
  InitPlan 1
    ->  Index Scan using users_email_key on users  (cost=0.28..8.30 rows=1 width=8) (actual time=0.010..0.010 rows=1 loops=1)
          Index Cond: (email = 'power.user@marketplace.example'::text)
          Buffers: shared hit=3
  ->  Index Only Scan using idx_orders_user_created_at on orders  (cost=0.42..4.48 rows=3 width=31) (actual time=0.039..0.042 rows=50 loops=1)
        Index Cond: ((user_id = (InitPlan 1).col1) AND (created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone))
        Heap Fetches: 0
        Buffers: shared hit=4 read=3
Planning:
  Buffers: shared hit=241 read=3
Planning Time: 0.680 ms
Execution Time: 0.083 ms
```

`idx_orders_user_created_at` removed both the sequential scan and sort; the
covering index stopped after 50 rows with zero heap fetches and reduced
execution time by about 107×.

## Q2 — pending fulfillment queue

### Before index

```text
Limit  (cost=3513.41..3513.66 rows=100 width=30) (actual time=7.486..7.497 rows=100 loops=1)
  Buffers: shared hit=1366
  ->  Sort  (cost=3513.41..3516.71 rows=1319 width=30) (actual time=7.485..7.489 rows=100 loops=1)
        Sort Key: created_at
        Sort Method: top-N heapsort  Memory: 37kB
        Buffers: shared hit=1366
        ->  Seq Scan on orders  (cost=0.00..3463.00 rows=1319 width=30) (actual time=0.007..7.242 rows=1278 loops=1)
              Filter: ((created_at >= '2025-08-15 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone) AND (status = 'pending'::text))
              Rows Removed by Filter: 118722
              Buffers: shared hit=1363
Planning:
  Buffers: shared hit=115
Planning Time: 0.511 ms
Execution Time: 7.532 ms
```

The unindexed queue query scanned every order and sorted 1,278 matching rows,
touching 1,366 shared buffers.

### After index

```text
Limit  (cost=0.29..4.75 rows=100 width=30) (actual time=0.045..0.067 rows=100 loops=1)
  Buffers: shared hit=1 read=3
  ->  Index Only Scan using idx_orders_pending_created_at on orders  (cost=0.29..58.25 rows=1298 width=30) (actual time=0.044..0.061 rows=100 loops=1)
        Index Cond: ((created_at >= '2025-08-15 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone))
        Heap Fetches: 0
        Buffers: shared hit=1 read=3
Planning:
  Buffers: shared hit=210 read=2
Planning Time: 1.346 ms
Execution Time: 0.104 ms
```

The partial `idx_orders_pending_created_at` contains only pending orders in
queue order, removing the scan and sort and reducing execution time by about
72× with zero heap fetches.

## Q3 — case-insensitive regional completed-order search

### Before index

```text
Limit  (cost=4128.48..4132.05 rows=31 width=22) (actual time=6.947..8.500 rows=50 loops=1)
  Buffers: shared hit=1400
  ->  Gather Merge  (cost=4128.48..4132.05 rows=31 width=22) (actual time=6.946..8.489 rows=50 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        Buffers: shared hit=1400
        ->  Sort  (cost=3128.47..3128.55 rows=31 width=22) (actual time=5.835..5.837 rows=39 loops=2)
              Sort Key: created_at DESC
              Sort Method: top-N heapsort  Memory: 30kB
              Buffers: shared hit=1400
              Worker 0:  Sort Method: top-N heapsort  Memory: 30kB
              ->  Parallel Seq Scan on orders  (cost=0.00..3127.71 rows=31 width=22) (actual time=0.012..5.611 rows=1100 loops=2)
                    Filter: ((created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone) AND (status = 'completed'::text) AND (lower((shipping_country)::text) = 'de'::text))
                    Rows Removed by Filter: 58900
                    Buffers: shared hit=1363
Planning:
  Buffers: shared hit=117
Planning Time: 0.383 ms
Execution Time: 8.549 ms
```

Applying `lower()` without an expression index forced a parallel sequential
scan and sort, touching 1,400 shared buffers.

### After index

```text
Limit  (cost=0.42..114.25 rows=50 width=22) (actual time=0.054..0.182 rows=50 loops=1)
  Buffers: shared hit=50 read=3
  ->  Index Scan using idx_orders_country_status_created_at on orders  (cost=0.42..4649.19 rows=2042 width=22) (actual time=0.054..0.178 rows=50 loops=1)
        Index Cond: ((lower((shipping_country)::text) = 'de'::text) AND (status = 'completed'::text) AND (created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone))
        Buffers: shared hit=50 read=3
Planning:
  Buffers: shared hit=207
Planning Time: 0.449 ms
Execution Time: 0.203 ms
```

The expression index matches `lower(shipping_country)` and keeps status and
time ordering in the index, removing the parallel scan and sort and reducing
execution time by about 42×.
