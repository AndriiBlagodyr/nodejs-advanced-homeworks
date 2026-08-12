# Homework — Dockerize API + Postgres

## Brief

Package the Lecture 4-style HTTP service (Express/Fastify) into a container and start it together with Postgres using a single command.

The goal is not “learn Docker”, but to understand three things that make real images weigh 1.2 GB instead of 180 MB and fail in production: how layer cache works, why multi-stage builds matter, and why the container must not run as root.

## What to do

### 1. Multi-stage Dockerfile

At least two stages:

| Stage | Contains |
|-------|----------|
| `builder` | dev dependencies, build |
| `runner` | production dependencies + build artifact only |

The final image must not include dev dependencies or source `.ts` / tests.

### 2. Layer order for cache

Copy `package*.json` and run `npm ci` **before** copying the rest of the code. Changing one line in `src/` must not reinstall dependencies.

### 3. Non-root

The final stage switches to an unprivileged user (`USER node` or a custom user via `adduser`). The process must not run as uid 0.

### 4. `.dockerignore`

At least: `node_modules`, `.git`, `Dockerfile`, `*.md`, `.env`.

### 5. `HEALTHCHECK`

In the Dockerfile, hits your `/health` endpoint.

### 6. `docker-compose.yml`

Two services: `api` and `postgres:17`. Postgres uses a named volume. API waits for DB readiness via `depends_on` + `condition: service_healthy`.

### 7. `docker-compose.override.yml` for dev

Bind-mounts code, enables hot-reload, keeps the port published. Base `docker-compose.yml` must remain usable for CI without the override.

### 8. `README.md`

Start commands and — required — final image size (`docker images`) next to a naive single-stage image size, with one sentence explaining the difference.

## Acceptance criteria

- [ ] Multi-stage is real (`FROM` ≥ 2; runner `npm ci` uses `--omit=dev` or `--only=production`)
- [ ] Layer cache: `COPY package` before `COPY . .`
- [ ] Non-root: `USER` present; `docker run --rm <image> id -u` ≠ 0
- [ ] `.dockerignore` includes `node_modules` and `.git`
- [ ] Healthcheck → `healthy` after `docker compose up -d`
- [ ] `docker compose up -d` → `GET /health` returns 200
- [ ] Postgres data survives `docker compose down` (without `-v`); documented in README
- [ ] `docker compose -f docker-compose.yml config` has no `source: ./src` bind mount
- [ ] README has both image sizes + one-sentence explanation

## Submission

Public GitHub repo (or branch `hw-05`) + Pull Request. Submit the **PR link** in the LMS.
