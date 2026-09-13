# Query optimization report

Environment: PostgreSQL 17.11 in Docker Desktop on Apple Silicon. The database
contained 120,000 orders and was vacuumed and analyzed before these plans were
captured.

## Q1 — order history for one user and month

### Before index

```text
Limit  (cost=3223.32..3223.33 rows=3 width=31) (actual time=6.995..7.000 rows=50 loops=1)
  Buffers: shared hit=1121
  InitPlan 1
    ->  Index Scan using users_email_key on users  (cost=0.28..8.30 rows=1 width=8) (actual time=0.011..0.012 rows=1 loops=1)
          Index Cond: (email = 'power.user@marketplace.example'::text)
          Buffers: shared hit=3
  ->  Sort  (cost=3215.02..3215.03 rows=3 width=31) (actual time=6.993..6.995 rows=50 loops=1)
        Sort Key: orders.created_at DESC
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: shared hit=1121
        ->  Seq Scan on orders  (cost=0.00..3215.00 rows=3 width=31) (actual time=0.020..5.840 rows=10000 loops=1)
              Filter: ((created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone) AND (user_id = (InitPlan 1).col1))
              Rows Removed by Filter: 110000
              Buffers: shared hit=1118
Planning:
  Buffers: shared hit=143
Planning Time: 0.456 ms
Execution Time: 7.042 ms
```

Without an orders index, PostgreSQL scanned all 120,000 orders and sorted the
10,000 matches, touching 1,121 shared buffers.

### After index

```text
Limit  (cost=8.72..12.79 rows=3 width=31) (actual time=0.058..0.066 rows=50 loops=1)
  Buffers: shared hit=4 read=3
  InitPlan 1
    ->  Index Scan using users_email_key on users  (cost=0.28..8.30 rows=1 width=8) (actual time=0.010..0.010 rows=1 loops=1)
          Index Cond: (email = 'power.user@marketplace.example'::text)
          Buffers: shared hit=3
  ->  Index Only Scan using idx_orders_user_created_at on orders  (cost=0.42..4.48 rows=3 width=31) (actual time=0.057..0.060 rows=50 loops=1)
        Index Cond: ((user_id = (InitPlan 1).col1) AND (created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone))
        Heap Fetches: 0
        Buffers: shared hit=4 read=3
Planning:
  Buffers: shared hit=242 read=3
Planning Time: 0.627 ms
Execution Time: 0.099 ms
```

`idx_orders_user_created_at` removed both the sequential scan and sort; the
covering index stopped after 50 rows with zero heap fetches and reduced
execution time by about 71×.

## Q2 — pending fulfillment queue

### Before index

```text
Limit  (cost=3263.23..3263.48 rows=100 width=30) (actual time=5.868..5.878 rows=100 loops=1)
  Buffers: shared hit=1118
  ->  Sort  (cost=3263.23..3266.39 rows=1262 width=30) (actual time=5.866..5.870 rows=100 loops=1)
        Sort Key: created_at
        Sort Method: top-N heapsort  Memory: 37kB
        Buffers: shared hit=1118
        ->  Seq Scan on orders  (cost=0.00..3215.00 rows=1262 width=30) (actual time=0.006..5.665 rows=1278 loops=1)
              Filter: ((created_at >= '2025-08-15 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone) AND (status = 'pending'::text))
              Rows Removed by Filter: 118722
              Buffers: shared hit=1115
Planning:
  Buffers: shared hit=95
Planning Time: 0.278 ms
Execution Time: 5.925 ms
```

The unindexed queue query scanned every order and sorted 1,278 matching rows,
touching 1,118 shared buffers.

### After index

```text
Limit  (cost=0.29..4.80 rows=100 width=30) (actual time=0.053..0.074 rows=100 loops=1)
  Buffers: shared hit=1 read=3
  ->  Index Only Scan using idx_orders_pending_created_at on orders  (cost=0.29..57.77 rows=1274 width=30) (actual time=0.052..0.067 rows=100 loops=1)
        Index Cond: ((created_at >= '2025-08-15 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone))
        Heap Fetches: 0
        Buffers: shared hit=1 read=3
Planning:
  Buffers: shared hit=201
Planning Time: 0.518 ms
Execution Time: 0.100 ms
```

The partial `idx_orders_pending_created_at` contains only pending orders in
queue order, removing the scan and sort and reducing execution time by about
59× with zero heap fetches.

## Q3 — regional completed-order search

### Before index

```text
Limit  (cost=3581.54..3581.66 rows=50 width=22) (actual time=6.331..6.336 rows=50 loops=1)
  Buffers: shared hit=1118
  ->  Sort  (cost=3581.54..3586.55 rows=2003 width=22) (actual time=6.330..6.332 rows=50 loops=1)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: shared hit=1118
        ->  Seq Scan on orders  (cost=0.00..3515.00 rows=2003 width=22) (actual time=0.008..6.059 rows=2200 loops=1)
              Filter: ((created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone) AND (shipping_country = 'DE'::bpchar) AND (status = 'completed'::text))
              Rows Removed by Filter: 117800
              Buffers: shared hit=1115
Planning:
  Buffers: shared hit=106
Planning Time: 0.357 ms
Execution Time: 6.370 ms
```

Without a country/status/time index, PostgreSQL scanned all 120,000 orders and
sorted the 2,200 matches, touching 1,118 shared buffers.

### After index

```text
Limit  (cost=0.42..3.14 rows=50 width=22) (actual time=0.058..0.065 rows=50 loops=1)
  Buffers: shared hit=1 read=3
  ->  Index Only Scan using idx_orders_country_status_created_at on orders  (cost=0.42..111.19 rows=2031 width=22) (actual time=0.058..0.061 rows=50 loops=1)
        Index Cond: ((shipping_country = 'DE'::bpchar) AND (status = 'completed'::text) AND (created_at >= '2025-08-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-09-01 00:00:00+00'::timestamp with time zone))
        Heap Fetches: 0
        Buffers: shared hit=1 read=3
Planning:
  Buffers: shared hit=209
Planning Time: 0.494 ms
Execution Time: 0.090 ms
```

`idx_orders_country_status_created_at` on the stored uppercase country code
removed the sequential scan and sort. Because the CHECK already forbids mixed
case, the covering index can satisfy the query with Index Only Scan, 4 buffers,
and about 71× less execution time — the same class of plan as Q2.
