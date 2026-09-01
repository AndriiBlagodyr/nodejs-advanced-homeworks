# HW-11 — Typed Configuration and Secret Rotation

This is the second homework of the Marketplace course project. The application
uses NestJS, PostgreSQL, and one validated configuration pipeline:

```text
process.env -> Zod schema -> ConfigService<Env, true> -> application code
file secret -> pg.Pool password callback -> PostgreSQL
```

Previous homework snapshots are archived in:

| Folder | Topic |
| --- | --- |
| [`hw-03/`](./hw-03) | Raw HTTP/HTTPS with `net` and `tls` |
| [`hw-05/`](./hw-05) | Docker, Compose, Express, and PostgreSQL |
| [`hw-09/`](./hw-09) | OpenAPI, idempotency, and contract validation |

## Configuration

All application variables are defined in
`src/config/env.schema.ts`. Invalid values are reported together before Nest
finishes creating its dependency graph.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DB_URL` | yes | none | PostgreSQL URL without a password |
| `PORT` | no | `3000` | HTTP port, coerced to an integer |
| `NODE_ENV` | no | `development` | `development`, `production`, or `test` |
| `DB_PASSWORD_FILE` | no | `secrets/db_password` | Path to the password file |

The password itself is never an environment variable. `DatabaseService`
passes an async password function to `pg.Pool`; every new connection rereads
`DB_PASSWORD_FILE`.

### Initial setup

Requires Node.js 22+, Docker with Compose, and OpenSSL.

```bash
npm install
cp .env.example .env
mkdir -p secrets
printf '%s\n' 'local_dev_password_change_me' > secrets/db_password
chmod 600 secrets/db_password
```

`.env` and `secrets/` are ignored by Git and excluded from the Docker build
context. The password above is only a local bootstrap value. On a clean
PostgreSQL volume, the official image initializes the `app` role from the same
Compose file secret, so the database and application cannot start with
different password sources.

### Run with Docker Compose

```bash
docker compose up --build -d
curl http://localhost:3000/health
curl http://localhost:3000/db
```

Expected responses:

```json
{"status":"ok","uptime":12.34}
{"status":"ok","database":"reachable"}
```

Stop the stack:

```bash
docker compose down
```

Use `docker compose down -v` when the PostgreSQL data volume must also be
removed. The next initialization reads the current value of
`secrets/db_password`.

### Run the API on the host

Start only PostgreSQL in Docker, then run Nest locally:

```bash
docker compose up -d postgres
npm run start
```

Development watch mode is intentionally separate:

```bash
npm run start:dev
```

## Rotate the database password

Keep the Compose stack running. Record the uptime, rotate, verify a new
database connection, and compare uptime again:

```bash
curl http://localhost:3000/health
bash rotate.sh
curl -i http://localhost:3000/db
curl http://localhost:3000/health
```

`rotate.sh` performs the required sequence:

1. `ALTER ROLE` changes the PostgreSQL password.
2. The mounted `secrets/db_password` file is updated.
3. Existing application connections are terminated.
4. `pg.Pool` opens a new connection and invokes the password function again.

The `/db` request remains successful and the second uptime is greater than the
first one because the API process is not restarted.

## Checks

Run all static and unit checks after a clean installation:

```bash
npm ci
npm test
```

### Fail-fast configuration

Temporarily hide the local env file and remove the required variable:

```bash
mv .env /tmp/marketplace.env
env -u DB_URL npm run start
echo $?
mv /tmp/marketplace.env .env
```

The process exits nonzero and reports `DB_URL`.

### `.env.example` synchronization

```bash
npm run check:env
```

The command compares `.env.example` against the actual Zod schema and exits
with code 1 for a missing, duplicate, undocumented, or uncommented variable.

### Git secret checks

```bash
git check-ignore .env secrets/db_password
git ls-files .env secrets/db_password
git status --ignored --porcelain | grep -E '^!! .*\.env$'
git ls-files | grep -c '\.env$'
```

The first command prints both ignored paths; the second prints nothing. The
last count is `0` because only `.env.example`, not `.env`, is tracked.

### Docker image secret checks

```bash
docker build -t myapp .
docker run --rm myapp ls -a /app
docker run --rm myapp sh -c 'cat /app/.env' 2>&1
docker inspect --format '{{.Config.Env}}' myapp
docker history --no-trunc myapp | grep -i password
```

`/app` contains `.env.example` but neither `.env` nor `secrets/`. Reading
`.env` fails with `No such file or directory`; image environment and history
contain no database password.

## Project layout

- `src/config/env.schema.ts` — Zod schema, `Env` type, and fail-fast validator.
- `scripts/check-env-example.mjs` — schema/example contract check.
- `src/database/` — dynamically authenticated PostgreSQL pool.
- `src/health/` — `/health` uptime and `/db` database probes.
- `secrets/db_password` — ignored local file secret.
- `rotate.sh` — live PostgreSQL password rotation.
- `docker-compose.yml` — local API and PostgreSQL stack.
