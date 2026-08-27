# HW-09 — Marketplace API Contract

Contract-first Marketplace API designed with OpenAPI 3.0.3. The specification
contains five operations across the `products` and `orders` resources, cursor
pagination, mandatory idempotency for order creation, and RFC 9457-style
`application/problem+json` errors.

## Contract option

This solution uses **Option B — runtime validation at the API boundary**.
Express OpenAPI Validator validates every request and response against
`openapi/openapi.yaml`. The application has in-memory data and implements all
five documented operations.

The optional full idempotency behavior is included:

- same `Idempotency-Key` and same body: the original `201` response with
  `Idempotency-Replay: true`;
- same key and a different body: `422 application/problem+json`.

## Install and run

Requires Node.js 22 or newer.

```bash
npm install
npm start
```

The API is available at `http://localhost:3000`.

## Automated checks

Lint the OpenAPI document (warnings are allowed, errors fail):

```bash
npm run lint:openapi
# equivalent acceptance-criteria command:
npx @redocly/cli lint openapi/openapi.yaml
```

Run the contract-backed HTTP tests:

```bash
npm test
```

Bundle the specification and check its operation/resource count and
idempotency declaration:

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json

node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).map(x=>x.\$ref?s.components.parameters[x.\$ref.split('/').at(-1)]:x).find(x=>x?.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('operations:',ops.length,'resources:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'description characters =',(idem?.description??'').trim().length)"
```

Expected: 5 operations, 2 resources, `required = true`, and an idempotency
description longer than 40 characters.

Run the textual acceptance checks:

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml
grep -c 'next_cursor' openapi/openapi.yaml
grep -c 'application/problem+json' openapi/openapi.yaml
```

## Manual runtime verification

Start the server in one terminal:

```bash
npm start
```

Then run:

```bash
# Missing Idempotency-Key: 400 problem+json from the OpenAPI validator
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"product_id":1,"quantity":1}]}'

# Empty items: 400 problem+json from the OpenAPI validator
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: empty-order' \
  -d '{"items":[]}'

# Valid request: 201
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1' \
  -d '{"items":[{"product_id":1,"quantity":2}]}'
```

## Project layout

- `openapi/openapi.yaml` — the source-of-truth API contract.
- `src/app.js` — Express routes, validator middleware, and problem handler.
- `src/index.js` — production entry point.
- `test/api.test.js` — runtime contract and idempotency tests.

Previous homeworks remain archived in [`hw-03/`](./hw-03) and
[`hw-05/`](./hw-05).
