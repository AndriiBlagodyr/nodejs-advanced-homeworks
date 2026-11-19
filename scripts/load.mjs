#!/usr/bin/env node
// Load generator: CONCURRENCY workers, paced to LOAD_RPS in total, until
// SIGINT/SIGTERM; then the in-flight requests finish and it exits. Every
// response code goes to OUT, one per line. "000" = no HTTP response at all
// (refused, reset, timeout), the same convention as curl's %{http_code}.
// No retries: a retry would turn a failure into a success.
//
// Each worker reuses its connection for LOAD_REQS_PER_CONN requests, then
// opens a new one, so the Service keeps re-balancing (a pod that is not
// listening yet gets its share) and a kept-alive socket is also exercised
// (it stays on its pod after the endpoint is removed). A new connection per
// request (=1) churns through Docker Desktop's port forwarding fast enough to
// get resets on the host side with no rollout at all.
//
//   node scripts/load.mjs <url> <out-file> [concurrency]

import { createWriteStream } from 'node:fs';
import http from 'node:http';

const [url, out, concurrencyArg] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/load.mjs <url> <out-file> [concurrency]');
  process.exit(2);
}
const concurrency = Number(concurrencyArg ?? 16);
const rps = Number(process.env.LOAD_RPS ?? 300);
const reqsPerConn = Number(process.env.LOAD_REQS_PER_CONN ?? 10);
const TIMEOUT_MS = 10_000;

const sink = createWriteStream(out, { flags: 'w' });
/** Optional: one line per failure, "<epoch ms> <cause> <reused socket 0|1>", for lining up with pod events. */
const trace = process.env.LOAD_TRACE ? createWriteStream(process.env.LOAD_TRACE, { flags: 'w' }) : null;
const errors = new Map();
let stopping = false;
let nextSlot = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paced() {
  const now = Date.now();
  const slot = Math.max(nextSlot, now);
  nextSlot = slot + 1000 / rps;
  if (slot > now) await sleep(slot - now);
}

function once(agent) {
  return new Promise((resolve) => {
    let settled = false;
    let reused = false;
    const startedAt = Date.now();
    const done = (code, err) => {
      if (settled) return;
      settled = true;
      if (err) {
        const key = err.code ?? err.message;
        errors.set(key, (errors.get(key) ?? 0) + 1);
        trace?.write(`${startedAt} ${key} ${reused ? 1 : 0}\n`);
      }
      sink.write(`${code}\n`);
      resolve();
    };
    const req = http.get(url, { agent, timeout: TIMEOUT_MS }, (res) => {
      res.resume();
      res.on('end', () => done(String(res.statusCode)));
      res.on('error', (err) => done('000', err));
    });
    req.on('socket', (socket) => {
      reused = req.reusedSocket;
      void socket;
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (err) => done('000', err));
  });
}

async function worker() {
  while (!stopping) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    for (let i = 0; i < reqsPerConn && !stopping; i++) {
      await paced();
      if (stopping) break;
      await once(agent);
    }
    agent.destroy();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (stopping = true));

await Promise.all(Array.from({ length: concurrency }, worker));
if (errors.size > 0) {
  console.error(`load: no-response causes ${[...errors].map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
sink.end(() => process.exit(0));
