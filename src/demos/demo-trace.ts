import '../observability/instrumentation';
import { loadObserveConfig } from '../observability/config';
import { takeLogLines } from '../observability/log-buffer';
import { bootApi, migrate } from './auth-kit';
import { fail, report } from './demo-kit';
import { drainLogs, makeTraceparent, orphanCount, pollTrace, send, spanHasError } from './observe-kit';

async function main(): Promise<void> {
  const observe = loadObserveConfig();
  await migrate();
  const api = await bootApi();
  takeLogLines();
  try {
    const { lines, ok } = await run(api.base, observe.traces);
    report(lines, ok);
  } finally {
    await api.app.close();
  }
}

async function run(base: string, tracesUrl: string) {
  const tp = makeTraceparent();
  const res = await send(base, '/demo/fail', { headers: { traceparent: tp.header } });
  const logs = drainLogs();
  await send(base, '/demo/flush', { method: 'POST' });
  const { spans } = await pollTrace(tracesUrl, tp.traceId);
  const spanTraceIds = new Set(spans.map((span) => span.traceID.replace(/-/g, '').toLowerCase()));
  const logTraceIds = logs.json
    .map((row) => row.trace_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => id.toLowerCase());

  const lines = {
    spans: spans.length,
    'orphan-spans': orphanCount(spans, tp.parentId),
    'trace-matches-header':
      spans.length > 0 && spans.every((span) => span.traceID.replace(/-/g, '').toLowerCase() === tp.traceId)
        ? 1
        : 0,
    // The log line against the span, not against the header we sent.
    'trace-matches-log': logTraceIds.some((id) => spanTraceIds.has(id)) ? 1 : 0,
    'span-status-error': spans.some(spanHasError) ? 1 : 0,
  };
  return {
    lines,
    ok:
      res.status >= 500 &&
      lines.spans >= 2 &&
      lines['orphan-spans'] === 0 &&
      lines['trace-matches-header'] === 1 &&
      lines['trace-matches-log'] === 1 &&
      lines['span-status-error'] === 1,
  };
}

main().catch(fail);
