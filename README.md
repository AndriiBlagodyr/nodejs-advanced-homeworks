# HW-16 — Integration tests, E2E, Contract (Pact)

Integration suite against real Postgres via testcontainers, E2E happy path with
supertest, and a Pact contract test with broker + `can-i-deploy` gate. Built on
the TypeORM layer from HW-13/14 and the OpenAPI spec from HW-9.

Previous snapshots: `hw-03/`, `hw-05/`, `hw-09/`, `hw-11/`, `hw-12/`, `hw-13/`, `hw-14/`, `hw-15/`.

## Тестування

### Commands

```bash
npm ci
npx tsc --noEmit          # compilation check

npm run test:integration  # 2 repos × 3+ tests (testcontainers)
npm run test:e2e          # supertest: happy path + 404 + 400
npm run test:contract     # Pact consumer → pacts/*.json
npm run verify:provider   # Pact provider verification
```

### Isolation strategy: TRUNCATE

Tests use `TRUNCATE … RESTART IDENTITY CASCADE` between each test (`beforeEach`).
This is simpler than transaction-ROLLBACK (which requires wrapping every test in
a managed transaction and breaks multi-connection scenarios) and faster than
container-per-file (which adds ~2 s of startup per spec file). TRUNCATE clears
all tables instantly and resets identity sequences, guaranteeing a clean slate.
Repeated runs are green without manual cleanup.

### Test data builders

`test/testkit/builders.ts` exports `aUser()`, `aProduct()`, `anOrder()`,
`anOrderItem()` — each produces a valid unique row with auto-incrementing
defaults. Tests use builders instead of raw SQL fixture walls.

### Contract: Pact + Broker

- **Consumer**: `test/contract/marketplace.consumer.spec.ts` — describes 2
  interactions (`GET /products`, `GET /products/1`) with `providerStates`.
- **Provider**: `test/contract/provider.verify.ts` — boots a real Nest app
  against a testcontainer, runs `stateHandlers` to seed the DB, and verifies.
- **Broker**: `pact-broker` service in `docker-compose.yml` (port 9292).
  Credentials: `pact:pact`.
- **CI**: `.github/workflows/contract.yml` — publish → verify → tag prod →
  `can-i-deploy`.

Locally, secrets (PACT_BROKER_URL, PACT_BROKER_TOKEN) come from the vault
via `bash scripts/with-secrets.sh dev npm run verify:provider`. Under
`SKIP_VAULT=1` the wrapper is a pass-through and values must be in the
environment directly:

```bash
export PACT_BROKER_URL=http://127.0.0.1:9292
export SKIP_VAULT=1
npm run verify:provider
```

### can-i-deploy gate demo

Below are the two states of the gate — unknown (before tagging prod) and
deployable (after tagging prod):

**Before tagging prod** (`"deployable": null, "unknown": 1`):
```json
{
  "deployable": null,
  "reason": "There is no verified pact between version grader-... of MarketplaceFrontend and the latest version of MarketplaceAPI with tag prod (...)",
  "success": 0,
  "failed": 0,
  "unknown": 1
}
```

**After tagging prod** (`"deployable": true`):
```json
{
  "deployable": true,
  "reason": "All required verification results are published and successful",
  "success": 1,
  "failed": 0,
  "unknown": 0
}
```

## Grading

```bash
# 1. Start stack
docker compose up -d --wait

# 2. Env for grader
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export SKIP_VAULT=1

# 3. Compile
npm ci && npx tsc --noEmit

# 4. Run tests (no DB needed — testcontainers start their own)
npm run test:integration
npm run test:e2e
npm run test:contract
npm run verify:provider

# 5. Broker gate demo (broker must be healthy from step 1)
export PACT_BROKER_URL=http://127.0.0.1:9292
CONSUMER_VERSION=grader-$(date +%s)

# Publish consumer contract
curl -s -X PUT \
  "$PACT_BROKER_URL/pacts/provider/MarketplaceAPI/consumer/MarketplaceFrontend/version/$CONSUMER_VERSION" \
  -H "Content-Type: application/json" \
  -u "pact:pact" \
  -d @pacts/MarketplaceFrontend-MarketplaceAPI.json

# Verify provider
PACT_BROKER_URL=$PACT_BROKER_URL PROVIDER_VERSION=$CONSUMER_VERSION \
  npm run verify:provider

# Before prod tag → unknown
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=MarketplaceFrontend&version=$CONSUMER_VERSION&to=prod" -u "pact:pact"

# Tag provider as prod
curl -s -X PUT \
  "$PACT_BROKER_URL/pacticipants/MarketplaceAPI/versions/$CONSUMER_VERSION/tags/prod" \
  -H "Content-Type: application/json" \
  -u "pact:pact"

# After prod tag → deployable true
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=MarketplaceFrontend&version=$CONSUMER_VERSION&to=prod" -u "pact:pact"
```
