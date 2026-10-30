# HW-26 — Files: presigned uploads, multipart resume, CDN without invalidation

Files (product photos, avatars, HW-15 dumps) no longer touch a server disk.
The API decides who may upload what and under which key. The bytes go from
the client straight into S3-compatible storage. Public assets are served by
a cache in front of a private bucket.

Previous snapshots: `hw-03/` … `hw-16/`, `hw-18/`, `hw-19/`, `hw-22/`, `hw-23/`, `hw-24/`.

## Files

### Pieces

| Piece | Where |
| --- | --- |
| `files` table (key, owner_id, status, size, upload_id, part_size, part_count, etag, idempotency_key) | `src/migrations/1726700000000-Files.ts` |
| intent / resume / commit / download | `src/files/files.service.ts`, `files.controller.ts` |
| allowlist, TTLs, threshold, part size, magic bytes | `src/files/policy.ts` |
| the only S3 client (presign, HeadObject, ListParts, Complete, purge) | `src/storage/storage.ts` |
| CDN edge (local CloudFront + OAC stand-in) | `src/cdn/edge.ts`, run with `npm run edge` |
| content-hashed asset publishing | `src/cdn/assets.ts` |
| emulator | `storage` in `docker-compose.yml`: MinIO, `:22650`, tmpfs `size=1g` |

The emulator is `pgsty/minio`, pinned to `RELEASE.2026-08-04T00-00-00Z`. That
is a maintained community build of MinIO. Docker Hub and quay.io no longer
serve `minio/minio`. The data lives in tmpfs, so `docker compose down` leaves
a clean slate. The `1g` size keeps a demo series from running out of space.

### Variables

| Змінна | Джерело | Навіщо |
| --- | --- | --- |
| `STORAGE_ACCESS_KEY` | сховище (#11) | storage access key: read and write every file in the bucket |
| `STORAGE_SECRET_KEY` | сховище (#11) | its secret |
| `STORAGE_ENDPOINT` | compose / оточення | `http://127.0.0.1:22650` for MinIO; empty means AWS S3 |
| `STORAGE_REGION` | compose / оточення | `us-east-1` unless set |
| `STORAGE_BUCKET` | compose / оточення | `hw26-files`; not a secret |
| `EDGE_PORT` | оточення | port of `npm run edge` (8088) |

The HW-24 auth variables (`JWT_*`, `REFRESH_TOKEN_PEPPER`) are still
required, because `intent` and `commit` sit behind the same `AuthGuard`. The
demos go through `scripts/with-secrets.sh dev`, like everything else. To use
the vault, add `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` to the `dev`
environment in Infisical. `npm run start` refuses to boot without the storage
variables and names the missing ones. Tests and the older demos boot
`AppModule` directly. Without storage they simply have no file endpoints.

The leak cost differs from `DATABASE_URL`. A leaked storage key can read and
write every file without touching our network. In production the app runs
under a role scoped to this bucket, not a long-lived key.

### The upload contract

1. `POST /uploads/intent` `{contentType, size, filename?}` sits behind the
   HW-24 `AuthGuard`. `contentType` must be in the allowlist (PNG, JPEG,
   WebP, PDF, gzip), or the answer is 415. Each type has its own size cap,
   and above it the answer is 413.
   - The server builds the key as `uploads/{userId}/{uuid}.{ext}`. The
     extension comes from the allowlist. `filename` is accepted and ignored,
     so `../../etc/passwd` never reaches the key.
   - A `PENDING` row is inserted. An `Idempotency-Key` header (HW-22) makes a
     double tap return the same file with fresh URLs instead of a second
     object.
2. The client `PUT`s the bytes to the presigned URL. Our process is not on
   that path. The signature covers the key, `Content-Type` and
   `Content-Length`. Another key in the path is 403 (`tampered`), and so is
   the right key with more bytes than declared (`oversized-put`). Storage
   enforces the size before commit ever sees the object. Part URLs sign
   their exact part length the same way.
3. `POST /uploads/:id/commit` checks the object, not the client's claim:
   - `HeadObject` must find it, or the answer is 409.
   - Its size must equal the declared size, or the object is deleted and
     the answer is 409.
   - Its first 16 bytes must match the declared type, or the object is
     deleted and the answer is 422. `Content-Type` is the client's word;
     the magic bytes are the file's.

   Only then does the row become `COMPLETED`. Someone else's file is 403
   (checked on the loaded row, as in HW-24).
4. `GET /files/:id` answers 302 to a presigned GET that lives 60 seconds.
   Nobody gets a long-lived download link. The guard runs on every request,
   so the API stays on the authorization path but off the data path.

The S3 client is created with `requestChecksumCalculation: 'WHEN_REQUIRED'`.
Otherwise a presigned PUT, signed before any body exists, would carry the
CRC32 of empty data. Logs carry `file_id` and the key, never a URL: a
presigned URL in a log line is access handed out until it expires.

### How long presigned URLs live

| URL | TTL | Why |
| --- | --- | --- |
| single PUT | 5 min | an avatar or product-photo form uploads right after intent. A single PUT is at most 8 MiB (above that it is multipart), about a minute at 1 Mbit/s, so 5 minutes leaves room for one retry and a slow start |
| multipart part | 15 min | one part (5 MiB and up), not the whole file; a resume asks for fresh URLs, so a long upload never needs a long URL |
| download (302) | 60 s | the browser follows the redirect at once |

A presigned URL cannot be revoked. It has no `jti` and no registry, so of the
HW-24 revocation strategies only "short" works. Also, `expiresIn: 7 days`
does not survive production. A URL dies with the credentials that signed it,
and a role session (STS) usually lasts an hour.

`expired=403` in the demo uses the same `Storage.presignPut` the API calls,
with a 2-second TTL. The same URL gives 200 while it is fresh and 403 after,
so the demo does not wait five minutes. The demo accepts any 4xx there (and
for `tampered` and `oversized-put`): S3 and MinIO refuse a bad or expired
signature with 403, some other S3-compatible stores with 400.

### Multipart: threshold, part size, resume

- **Threshold is computed:** `multipartThreshold()` in `src/files/policy.ts`.
  It answers: how much can a dropped single PUT cost to redo from zero?
  - The budget is 64 s on the slowest link we design for: a 1 Mbit/s
    mobile uplink, about 128 KiB/s.
  - That gives 64 × 128 KiB = **8 MiB**, which is also the AWS CLI default
    (`multipart_threshold = 8MB`).
  - The result is never below two minimum parts (5 MiB + 1 MiB). Otherwise a
    "multipart" file would be one part plus a stub, and resume would gain
    nothing.
- **Part size is computed:** `max(5 MiB, ceil(size / 10 000) rounded up to
  a MiB)`. At most 10,000 parts, each 5 MiB to 5 GiB except the last. A
  fixed 5 MiB fails above about 48.8 GiB; the computed size gives 6 MiB at
  50 GiB and 525 MiB at 5 TiB (`test/unit/files-policy.spec.ts`).
- **Resume:** `POST /uploads/:id/resume` asks the storage with `ListParts`
  which parts it already has. It returns fresh URLs only for the missing
  ones. The new process has no memory of the old one, and needs none. If
  the upload was already aborted, by the orphan sweep or the lifecycle
  rule, the answer is 410, and the client starts a new intent.
- **Commit:** `CompleteMultipartUpload` uses the part list from `ListParts`,
  not from the client. Each part's size is checked against the plan first,
  so a wrong part is a 409 rather than `EntityTooSmall`. A second,
  concurrent commit finds the upload already completed and falls through to
  `HeadObject`, so it does not fail with a 500.

Size is only one of the four multipart benefits in the S3 docs. The others
are faster upload through parallel parts, pause and resume, and starting
before the final size is known. This demo is about resume.

A multipart ETag is not an MD5. It is the MD5 of the parts' MD5s, plus `-N`
for the number of parts. Code that compares it with a local MD5 breaks
silently.

### CDN: which form, and the AWS policy

**Local form.** `src/cdn/edge.ts` is about 60 lines of logic:
- It reads the private bucket with its own credentials, through the same
  SDK client, and keeps an LRU in memory.
- The LRU is bounded by **bytes**, not entries: 64 MiB of bodies in total
  (`EDGE_MAX_BYTES`), least recently used evicted first. An object above
  10 MiB is served but not cached, so one large file cannot flush the rest.
  A count limit would have allowed 1000 × 10 MiB ≈ 10 GiB.
- It answers `GET` and `HEAD` (`curl -sSI` gets the headers and
  `Content-Length` from the cache), and `304` with no body when
  `If-None-Match` matches the ETag. Other methods are `405`.
- It answers with `X-Cache: HIT|MISS`.
- It coalesces concurrent misses into one origin fetch.
- It serves `assets/` only; user uploads never go through it.
- It answers 400 to a malformed path.

That is the OAC idea: the cache reaches storage, the public reaches the
cache. The bucket has no policy at all, so an anonymous GET straight at
storage is 403. Locally the edge reuses the app's storage key. In
production it gets its own identity, allowed only `s3:GetObject` on
`assets/*`, which is what the OAC policy below grants CloudFront.

What the edge caches, and for how long, comes from the object's own
`Cache-Control`. `publishAsset` sets that header when it uploads the asset:
`public, max-age=31536000, immutable`. An object uploaded without it is
never cached (`no-cache-control-hit=0` in the demo).

**AWS form:** CloudFront with Origin Access Control and this bucket policy.
The `AWS:SourceArn` condition is what limits access to *this* distribution;
without it, any CloudFront distribution in the world could read the bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOACReadAssets",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::hw26-files/assets/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE"
        }
      }
    }
  ]
}
```

Leave Block Public Access on. This is a service-principal grant, not a
public one. For private content (paid downloads), the plan is CloudFront
signed URLs or signed cookies. The signing key goes in the vault, because
whoever holds it can grant access to everything in the distribution.

### Updates without invalidation

A deploy publishes `app.css` as `assets/app.<sha256[0..8]>.css`. New content
gets a new name, the HTML points at the new URL, and the old cache entry is
never asked for again. Nothing is invalidated. AWS itself recommends
versioned file names over invalidation for files that change often.
`old-url-still-hit=1` shows the old entry is still in the cache and harms
nobody.

### Hygiene: orphans and unfinished uploads

- **Orphan files.** An intent that is never committed leaves a `PENDING`
  row, and maybe an object or unfinished parts. `src/files/orphans.ts`
  sweeps `PENDING` rows older than a day, using the partial index
  `idx_files_pending_created_at`:
  - `AbortMultipartUpload`, then `DeleteObject`, then delete the row.
  - Storage goes first and the row last, so a crash in between is retried
    on the next sweep.
  - `FOR UPDATE SKIP LOCKED` lets two workers share the work.

  It runs as the BullMQ scheduler `files-orphan-sweep`, hourly, in the HW-23
  worker (`npm run worker`) when storage is configured. `demo:upload` ages
  its never-committed intent by two days, runs the sweep, and prints
  `orphan-swept=1`.
- **Unfinished multipart uploads are billed** although no object exists and
  the console does not show them. On AWS the fix is the lifecycle rule
  `AbortIncompleteMultipartUpload: 7 days`. `npm run storage:setup` tries to
  install it. MinIO rejects that rule (`InvalidArgument`) and instead cleans
  stale uploads itself (`stale_uploads_expiry=24h`), so the script prints
  `abort-incomplete-multipart-rule=0` locally. "Delete everything older than
  30 days" does not touch these uploads; it is a different action.
- **The list of a user's files is the `files` table,** not a bucket listing.
  A listing is paid and slow, at 1,000 keys per call.
- **Backups (HW-15).** Their destination is now this bucket, and lifecycle
  makes it cheap. Two caveats: Glacier breaks the RTO, because the object
  must be restored first, and lifecycle does not verify a backup. The
  restore drill stays.

### Demos, from my runs

Each demo cleans its own state first:
- `ListMultipartUploads` → `AbortMultipartUpload` and delete for its users'
  prefixes, or `assets/` for `demo:cdn`;
- then the users, whose `files` rows are deleted with them.

Upload and resume are done by child processes whose environment is only
`PATH`. They print `env-keys=0` themselves. A demo kills any child still
running when it exits, the Node version of `trap … EXIT`. The API and the
edge listen on port 0, so every run gets its own free port and a second run
never hits `EADDRINUSE`.

```text
$ npm run demo:upload
intent=200  key-from-server=1  intent-idempotent=1  put-ttl-sec=300
tampered=403  oversized-put=403  commit-without-bytes=409
api-alive=0  put-env-keys=0  put-offline=200
foreign-commit=403  commit=200  status-completed=1
download=302  download-body-match=1  expiry-probe-fresh=200  expired=403
orphan-swept=1

$ npm run demo:multipart        # same numbers on the second run
file-bytes=12582912  part-size-mib=5  parts=3  intent=200  uploader-env-keys=0
first-process-killed=1  parts-before-crash=2  head-before-complete=404
resumed-parts=1  complete=200  size-match=1  etag-multipart=1

$ npm run demo:cdn
direct=403  edge-miss=200  edge-miss-x-cache-miss=1  edge-hit=200  cache-hit=1
cache-control-immutable=1  edge-head=200  head-x-cache-hit=1  head-body-bytes=0
head-content-length-match=1  revalidate=304  revalidate-body-bytes=0
no-cache-control-hit=0  new-name=1  new-url=200  content-changed=1  old-url-still-hit=1
invalidations=0  origin-fetches=4
```

What the main lines prove:
- `demo:upload`:
  - `api-alive=0` with `put-offline=200`: the API was closed (a raw TCP
    probe confirms it), and a keyless process still got the bytes in.
  - `tampered=403`: the same signature with another key in the path fails,
    so the signature covers the path.
  - After the PUT, the API comes back on a different port, because a pooled
    socket to the old port would be dead.
- `demo:multipart`: process A is killed with SIGKILL after two parts.
  Process B uploads only the third. Before Complete, `HeadObject` is 404
  even though two parts are stored.
- `demo:cdn`: `origin-fetches=4` breaks down as follows. `v1` was fetched
  once and then served from the cache four times: a GET, a `HEAD`, a
  conditional GET answered `304`, and the old-URL read after the deploy. The
  object without `Cache-Control` was fetched both times. `v2` was fetched
  once.

---

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
one COMMIT. The grader also does not set `REDIS_URL`.

**Revocation is per family, not per `jti`.** Every access token carries `fid`.
`revoked_families` holds a revoked family for `ACCESS_TTL` (10 minutes), the
longest any access token of it can still live. `authenticate` checks `fid`
there and `jti` in `access_denylist` in one query.

**Nothing grows forever.** Login and logout sweep expired rows from
`refresh_tokens`, `access_denylist` and `revoked_families`, using the
`expires_at` index on each table. Each sweep deletes at most 500 rows per
table with `FOR UPDATE SKIP LOCKED`, so concurrent logins do not queue
behind each other. An expired refresh token is rejected by `expires_at`
anyway, so deleting its row loses nothing.

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
of the family and puts the family into `revoked_families`. The log line is
`refresh token reuse; family revoked family_id=…` (the id only, never the
token). Both the thief and the honest client are out, refresh and access
alike. `a1-after-reuse=401` and `a2-after-reuse=401` show the access side:
the thief does not get to keep the 10 minutes left on their access token.
Rotation without the family would leave the honest client's new token alive.

There is no grace window. The client serializes refresh: one in-flight promise
for everyone. A window that handed back the same new pair would make an
immediate second presentation look successful, and a parallel refresh of one
token is treated as theft. That is the tradeoff, and it is why `r1-reuse` is
401 with no delay.

### Why logout is two actions

The refresh token is a row. Logout sets `revoked_at` on its family, and that
is enough for it. Access tokens are self-contained and valid until `exp`, so
logout also denylists them. That means the family (`fid` into
`revoked_families`, covering every access token of this login) and the
presented `jti` (`access_denylist`, `expires_at` = its `exp`). Everything
commits together. A `jti`-only denylist is not enough: the access token
issued before the last refresh has a different `jti` and would still answer
200. `old-access-after-logout=401` is that case. `refresh-after-logout=401`
is the refresh family. Either action alone leaves a usable credential.

### 401, 403, and where ownership is checked

No token, a bad signature, an expired token, or a revoked `fid`/`jti` is **401**.
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
logout=204  after-logout=401  old-access-after-logout=401
refresh-after-logout=401  expired-refresh-swept=1

$ npm run demo:reuse
login=200  r1-refresh=200  a2-before-reuse=200  r1-reuse=401
r2-after-reuse=401  a1-after-reuse=401  a2-after-reuse=401

$ npm run demo:rbac
anon=401  own=200  foreign=403
role-denied=403  role-allowed=201  tampered=401
```

`tampered` is the same access token with `role` rewritten to `admin` and the
old signature left in place. No signing key is used to build it. A verifier
that only decoded the payload would return 201 here.

The same invariants run in `npm run test:e2e` (`Auth E2E`): family revocation
on reuse (refresh and access), logout killing every access token of the login
while another login of the same user keeps working, the sweep of expired
refresh rows, 401/403/200 on an order, the list
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

The storage is the local MinIO from `docker-compose.yml` (port `22650`). Its
dev credentials are already in the compose file and are not a secret. No AWS
account is needed. Uploads run under the HW-24 guards, so the block also
makes a one-time ES256 key pair and pepper. The real signing key stays in the
vault. This pair lives only in a temp dir that is deleted right after it is
exported. The DB password is read from the local `db` container, so no
connection string with a password is written down here.

```bash
docker compose up -d --wait
export STORAGE_ENDPOINT=http://127.0.0.1:22650
export STORAGE_REGION=us-east-1
export STORAGE_ACCESS_KEY=hw26user
export STORAGE_SECRET_KEY=hw26secretpass
export STORAGE_BUCKET=hw26-files
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
npm run demo:upload
npm run demo:multipart
npm run demo:multipart
npm run demo:cdn
```

Each demo compiles first (`predemo:*` runs `tsc`), applies pending migrations
and creates the bucket if it is missing. It leaves the bucket private, with no
bucket policy. The HW-24 demos (`demo:auth`, `demo:reuse`, `demo:rbac`) run
under the same exports. `5432` is PgBouncer in front of Postgres. `5672` is AMQP.
`6390` is the cache Redis and `6391` the queue Redis, still used by the HW-23
demos (`demo:cache`, `demo:session`, `demo:ratelimit`, `demo:queue`) and the
HW-22 ones (`demo:outbox`, `demo:crash-write`, `demo:crash-relay`). None of
the ports are in 22300–22399. `22650` is the S3 API of the `storage` service
and `22651` its console. `npm run start` without the auth or storage secrets
exits non-zero and names every missing variable; it does not open the
database first.
