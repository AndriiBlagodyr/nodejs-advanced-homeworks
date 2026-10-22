#!/usr/bin/env node
import { io } from 'socket.io-client';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const sameRoom = process.argv.includes('--same-room');

async function createOrder() {
  const res = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ product_id: 1, quantity: 1 }] }),
  });
  if (!res.ok) {
    throw new Error(`create order failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function patchStatus(orderId, status) {
  const res = await fetch(`${BASE}/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    throw new Error(`patch status failed: ${res.status} ${await res.text()}`);
  }
}

function connectAndJoin(orderId, userId) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      auth: { userId },
      transports: ['websocket'],
    });
    const received = { count: 0 };
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`join timeout for order ${orderId}`));
    }, 8000);

    socket.on('order.status', () => {
      received.count += 1;
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('connect', () => {
      socket.emit('join', { orderId }, (ack) => {
        clearTimeout(timer);
        if (!ack?.ok) {
          socket.close();
          reject(new Error(ack?.error ?? 'join refused'));
          return;
        }
        resolve({ socket, received });
      });
    });
  });
}

async function main() {
  const orderA = (await createOrder()).id;
  const orderB = (await createOrder()).id;
  const roomB = sameRoom ? orderA : orderB;

  const clientA = await connectAndJoin(orderA, '1');
  const clientB = await connectAndJoin(roomB, '1');

  await patchStatus(orderA, 'cancelled');
  await new Promise((r) => setTimeout(r, 400));

  const aReceived = clientA.received.count;
  const bReceived = clientB.received.count;
  console.log(`A_RECEIVED=${aReceived}`);
  console.log(`B_RECEIVED=${bReceived}`);

  const expectedB = sameRoom ? 1 : 0;
  const ok = aReceived === 1 && bReceived === expectedB;

  clientA.socket.close();
  clientB.socket.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
