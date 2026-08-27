import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

let baseUrl;
let server;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('the OpenAPI contract requires Idempotency-Key', async () => {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ product_id: 1, quantity: 1 }] }),
  });
  const problem = await response.json();

  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  assert.match(
    problem.detail,
    /must have required property 'idempotency-key'/,
  );
});

test('the OpenAPI contract rejects an empty items array', async () => {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'empty-order',
    },
    body: JSON.stringify({ items: [] }),
  });
  const problem = await response.json();

  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  assert.match(problem.detail, /items must NOT have fewer than 1 items/);
});

test('a valid order is created and conforms to the response schema', async () => {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'new-order',
    },
    body: JSON.stringify({ items: [{ product_id: 1, quantity: 2 }] }),
  });
  const order = await response.json();

  assert.equal(response.status, 201);
  assert.equal(order.total_cents, 25800);
  assert.equal(order.items[0].line_total_cents, 25800);
  assert.equal(response.headers.get('location'), `/orders/${order.id}`);
});

test('the same key and body replays the original successful response', async () => {
  const body = JSON.stringify({ items: [{ product_id: 3, quantity: 1 }] });
  const headers = {
    'content-type': 'application/json',
    'idempotency-key': 'replay-order',
  };

  const first = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers,
    body,
  });
  const firstOrder = await first.json();

  const replay = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers,
    body,
  });
  const replayedOrder = await replay.json();

  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.deepEqual(replayedOrder, firstOrder);
  assert.equal(replay.headers.get('idempotency-replay'), 'true');
});

test('the same key with a different body returns problem+json', async () => {
  const headers = {
    'content-type': 'application/json',
    'idempotency-key': 'conflicting-order',
  };

  await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ items: [{ product_id: 4, quantity: 1 }] }),
  });

  const conflict = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ items: [{ product_id: 4, quantity: 2 }] }),
  });
  const problem = await conflict.json();

  assert.equal(conflict.status, 422);
  assert.match(conflict.headers.get('content-type'), /^application\/problem\+json/);
  assert.equal(problem.title, 'Idempotency Conflict');
});

test('product pagination returns an opaque next cursor', async () => {
  const first = await fetch(`${baseUrl}/products?limit=2`);
  const firstPage = await first.json();
  const second = await fetch(
    `${baseUrl}/products?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
  );
  const secondPage = await second.json();

  assert.equal(first.status, 200);
  assert.equal(firstPage.items.length, 2);
  assert.equal(typeof firstPage.next_cursor, 'string');
  assert.equal(second.status, 200);
  assert.equal(secondPage.items[0].id, 3);
});
