# HW-18 — Realtime order status (WebSocket + SSE)

Instant `order.status` notifications over two transports: a Socket.IO gateway
with rooms `orders:<id>`, and an SSE stream at `GET /orders/:id/events`.
Built on the Marketplace API from previous homeworks.

Previous snapshots: `hw-03/`, `hw-05/`, `hw-09/`, `hw-11/`, `hw-12/`, `hw-13/`,
`hw-14/`, `hw-15/`, `hw-16/`.

## Commands

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export SKIP_VAULT=1

npm ci
npm run build
npm run migrate
npm run seed
npm start
```

The API listens on `http://127.0.0.1:3000`.

Change status (emits into the room and the SSE bus from `OrdersService`, not
from the controller):

```bash
curl -s -X PATCH http://127.0.0.1:3000/orders/1/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"cancelled"}'
```

SSE:

```bash
curl -sN --max-time 5 http://127.0.0.1:3000/orders/1/events
```

Room isolation demo (two Socket.IO clients):

```bash
node scripts/realtime-demo.mjs
node scripts/realtime-demo.mjs --same-room
```

## Trade-offs: WebSocket vs SSE

| Criterion | WebSocket (Socket.IO) | SSE |
| --- | --- | --- |
| Channel direction | Bidirectional: client can `join` and send later messages | Server → client only; subscribe is a GET |
| Reconnect / recovery | Socket.IO reconnects on the manager; missed events need your own buffer | Native `Last-Event-ID` + `id:` replay from an in-memory buffer |
| Infra requirements | Sticky sessions or a Redis adapter behind a load balancer | Ordinary HTTP; works through more proxies and HTTP/2 |
| Cost per event | Framing + room fan-out; idle sockets stay open | Cheap HTTP write; idle connections are just open responses |

For production order-status notifications I would keep **SSE**. The payload is
one-way, `Last-Event-ID` recovers gaps without a custom protocol, and the
endpoint is a normal GET. WebSocket stays useful if the client later needs
to send commands on the same connection; for “status changed” that extra
channel is unused cost.

A single in-process room map and event `Subject` break when you run two
instances: a client on instance A never sees `server.to(...)` from instance B.
That is fixed with a Redis adapter (`@socket.io/redis-adapter`) so rooms and
emits are shared across processes.

## Grading

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://app:marketplace_dev_password@127.0.0.1:5432/marketplace
export SKIP_VAULT=1

npm ci
npm run build
npm run migrate
npm run seed
npm start
```

In another terminal (app already listening on :3000):

```bash
# SSE header
curl -sN --max-time 2 -D - -o /dev/null http://127.0.0.1:3000/orders/1/events | grep -i '^content-type'

# Isolation — different rooms
node scripts/realtime-demo.mjs; echo "exit=$?"

# Isolation — same room (control)
node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
```
