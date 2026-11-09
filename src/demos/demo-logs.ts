import '../observability/instrumentation';
import { takeLogLines } from '../observability/log-buffer';
import { bootApi, migrate } from './auth-kit';
import { fail, report } from './demo-kit';
import { drainLogs, makeTraceparent, send } from './observe-kit';

const TOKEN_A = 'hw29-secret-token-aaaaaaaa';
const TOKEN_B = 'hw29-secret-password-bbbbbbbb';
const BURST = 8;
const LAYERS = ['products.controller', 'products.service', 'products.repo'];

async function main(): Promise<void> {
  await migrate();
  const api = await bootApi();
  takeLogLines();
  try {
    const { lines, ok } = await run(api.base);
    report(lines, ok);
  } finally {
    await api.app.close();
  }
}

async function run(base: string) {
  const one = makeTraceparent();
  await send(base, '/products/1', { headers: { traceparent: one.header, 'x-tenant': 'hw29' } });
  const first = drainLogs();
  const ofTrace = first.json.filter((row) => row.trace_id === one.traceId);
  const layers = new Set(
    ofTrace.map((row) => row.layer).filter((layer): layer is string => typeof layer === 'string'),
  );

  const burstParents = Array.from({ length: BURST }, () => makeTraceparent());
  await Promise.all(
    burstParents.map((p) => send(base, '/products/1', { headers: { traceparent: p.header } })),
  );
  const burstLogs = drainLogs();
  const groups = new Map<string, number>();
  for (const row of burstLogs.json) {
    if (typeof row.trace_id !== 'string') continue;
    if (!row.layer) continue;
    groups.set(row.trace_id, (groups.get(row.trace_id) ?? 0) + 1);
  }
  const burstIds = burstParents.map((p) => p.traceId);
  const present = burstIds.filter((id) => groups.has(id));
  const sizes = present.map((id) => groups.get(id) ?? 0);
  const expected = sizes[0] ?? 0;
  const burstUneven = sizes.some((n) => n !== expected) ? 1 : 0;

  await send(base, '/auth/login', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN_A}` },
    body: { email: 'nobody@example.com', password: TOKEN_B },
  });
  const secretLogs = drainLogs();
  const dumped = secretLogs.json.filter((row) => row.msg === 'request').length;
  const joined = JSON.stringify(secretLogs.json);

  const lines = {
    'non-json-lines': first.nonJson + burstLogs.nonJson + secretLogs.nonJson,
    layers: LAYERS.filter((name) => layers.has(name)).length,
    'distinct-trace-ids': new Set(ofTrace.map((row) => row.trace_id)).size,
    'trace-id-matches-header': ofTrace.some((row) => row.trace_id === one.traceId) ? 1 : 0,
    burst: BURST,
    'burst-trace-ids': present.length,
    'burst-uneven': burstUneven,
    'secret-req-logged': dumped > 0 ? 1 : 0,
    'secret-in-logs': joined.includes(TOKEN_A) || joined.includes(TOKEN_B) ? 1 : 0,
  };
  return {
    lines,
    ok:
      lines['non-json-lines'] === 0 &&
      lines.layers >= 3 &&
      lines['distinct-trace-ids'] === 1 &&
      lines['trace-id-matches-header'] === 1 &&
      lines.burst >= 8 &&
      lines['burst-trace-ids'] === lines.burst &&
      lines['burst-uneven'] === 0 &&
      lines['secret-req-logged'] === 1 &&
      lines['secret-in-logs'] === 0,
  };
}

main().catch(fail);
