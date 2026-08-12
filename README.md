# HW-05 — Dockerized Express API + Postgres

Assignment: [`TASK.md`](./TASK.md).

Minimal Express API with `GET /health` and `GET /users`, packaged with Postgres via Docker Compose.

Previous homework (kept for reference): [`hw-03/`](./hw-03) — raw HTTP/HTTPS on `net` / `tls`.

## Setup

```bash
cp .env.example .env
```

`.env` holds Postgres credentials (not committed). Compose substitutes `${POSTGRES_PASSWORD}` etc. from it.

## Run (grader)

```bash
cp .env.example .env   # if .env is missing
docker compose up -d
```

Host port `3000` comes from `docker-compose.override.yml` (dev). Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health
# 200

curl -s http://localhost:3000/users
```

Stop (keeps the Postgres named volume):

```bash
docker compose down
```

## Dev mode

`docker-compose.override.yml` is loaded automatically by `docker compose up` and enables:

- published ports `3000` (API) and `5432` (Postgres, e.g. Beekeeper)
- bind mount of `./src`
- hot-reload via `nodemon` (builder stage)

CI / production-like run without override (no host ports — avoids collisions in parallel jobs):

```bash
docker compose -f docker-compose.yml up -d --build
```

## Image sizes

Measured with `docker images` after:

```bash
docker build -t hw05-api:multi -f Dockerfile .
docker build -t hw05-api:naive -f Dockerfile.naive .
docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}'
```

Environment: **Docker 29.6.2**, platform **darwin/arm64** (Apple Silicon).

| Image | Tag | Size |
|-------|-----|------|
| Multi-stage (`node:22-slim` + `npm ci --omit=dev`) | `hw05-api:multi` | **251MB** |
| Naive single-stage (`node:22` + full `npm install`) | `hw05-api:naive` | **1.14GB** |

Sizes vary by Docker Engine version and CPU architecture (e.g. ~336MB / ~1.64GB on some Docker 29 / amd64 setups); compare both images on the same machine.

The multi-stage slim image is much smaller because it drops the fat default Node base (~1GB) and installs only production dependencies in the final stage, leaving nodemon/dev tooling in the discarded builder stage.

## Postgres persistence check

Named volume `pgdata` survives `docker compose down` (without `-v`).

```bash
# 1) start stack
docker compose up -d --build

# 2) create an extra row
docker compose exec postgres \
  psql -U app -d app -c "INSERT INTO users (name) VALUES ('PersistMe');"

docker compose exec postgres \
  psql -U app -d app -c "SELECT * FROM users ORDER BY id;"

# 3) stop without deleting volumes
docker compose down

# 4) start again — PersistMe must still be there
docker compose up -d
docker compose exec postgres \
  psql -U app -d app -c "SELECT * FROM users ORDER BY id;"
```

## Useful checks

```bash
# non-root
docker run --rm --entrypoint id hw05-api:multi -u
# → 1000

# health
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q api)"

# base compose has no src bind mount and no host port 3000
docker compose -f docker-compose.yml config | grep -c 'source: ./src'
# → 0
docker compose -f docker-compose.yml config | grep -c 'published: "3000"'
# → 0
```
