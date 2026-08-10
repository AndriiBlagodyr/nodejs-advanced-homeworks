# HW-05 — Dockerized Express API + Postgres

Assignment: [`TASK.md`](./TASK.md).

Minimal Express API with `GET /health` and `GET /users`, packaged with Postgres via Docker Compose.

Previous homework (kept for reference): [`hw-03/`](./hw-03) — raw HTTP/HTTPS on `net` / `tls`.

## Run (grader)

```bash
docker compose up -d
```

Then:

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

- bind mount of `./src`
- hot-reload via `nodemon` (builder stage)
- published port `3000`

CI / production-like run without override:

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

| Image | Tag | Size |
|-------|-----|------|
| Multi-stage (`node:22-slim` + `npm ci --omit=dev`) | `hw05-api:multi` | **251MB** |
| Naive single-stage (`node:22` + full `npm install`) | `hw05-api:naive` | **1.14GB** |

The multi-stage slim image is much smaller because it drops the fat default Node base (~1GB) and installs only production dependencies in the final stage, leaving nodemon/dev tooling in the discarded builder stage.

## Postgres persistence check

Named volume `pgdata` survives `docker compose down` (without `-v`).

```bash
# 1) start stack
docker compose -f docker-compose.yml up -d --build

# 2) create an extra row
docker compose -f docker-compose.yml exec postgres \
  psql -U app -d app -c "INSERT INTO users (name) VALUES ('PersistMe');"

docker compose -f docker-compose.yml exec postgres \
  psql -U app -d app -c "SELECT * FROM users ORDER BY id;"

# 3) stop without deleting volumes
docker compose -f docker-compose.yml down

# 4) start again — PersistMe must still be there
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml exec postgres \
  psql -U app -d app -c "SELECT * FROM users ORDER BY id;"
```

## Useful checks

```bash
# non-root
docker run --rm --entrypoint id hw05-api:multi -u
# → 1000

# health
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q api)"

# base compose has no src bind mount
docker compose -f docker-compose.yml config | grep -c 'source: ./src'
# → 0
```
