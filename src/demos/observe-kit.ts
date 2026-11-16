import { randomBytes } from 'node:crypto';
import { HTTP_REQUEST_DURATION, HTTP_REQUESTS_TOTAL, TOP_FINITE_BUCKET_SECONDS } from '../observability/config';
import { takeLogLines } from '../observability/log-buffer';

export function makeTraceparent(): { header: string; traceId: string; parentId: string } {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return { header: `00-${traceId}-${parentId}-01`, traceId, parentId };
}

export function parseJsonLines(lines: string[]): { json: Record<string, unknown>[]; nonJson: number } {
  let nonJson = 0;
  const json: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      json.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      nonJson += 1;
    }
  }
  return { json, nonJson };
}

export function drainLogs() {
  return parseJsonLines(takeLogLines());
}

export async function send(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, text: await res.text() };
}

export async function scrapeMetrics(base: string): Promise<string> {
  const res = await fetch(`${base}/metrics`);
  if (!res.ok) throw new Error(`GET /metrics -> ${res.status}`);
  return res.text();
}

/** Sum of `http_requests_total` samples, optionally filtered by a label matcher. */
export function counterTotal(text: string, labels: Record<string, string> = {}): number {
  return sumSamples(text, HTTP_REQUESTS_TOTAL, labels);
}

export function hasRoute(text: string, route: string): boolean {
  return text.includes(`route="${route}"`);
}

/** A raw id in the route label (`/products/900001`) means the template was not used. */
export function rawIdRoute(text: string): boolean {
  return /route="\/[^"]*\/[0-9]+"/.test(text);
}

export function counterSeries(text: string): number {
  const prefix = `${HTTP_REQUESTS_TOTAL}{`;
  return text.split('\n').filter((line) => line.startsWith(prefix)).length;
}

export function errorsTotal(text: string): number {
  let sum = 0;
  const prefix = `${HTTP_REQUESTS_TOTAL}{`;
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const status = /status="(\d+)"/.exec(line)?.[1];
    if (status && status.startsWith('5')) sum += Number(line.split(' ').pop());
  }
  return sum;
}

/**
 * `_count` minus the top finite `_bucket` for this route. Zero means every
 * observation fitted under the last numbered `le`.
 */
export function aboveTopBucket(text: string, route: string): number {
  const count = sumSamples(text, `${HTTP_REQUEST_DURATION}_count`, { route });
  const top = sumSamples(text, `${HTTP_REQUEST_DURATION}_bucket`, {
    route,
    le: String(TOP_FINITE_BUCKET_SECONDS),
  });
  return count - top;
}

function sumSamples(text: string, metric: string, labels: Record<string, string>): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(metric)) continue;
    const brace = line.indexOf('{');
    const name = brace === -1 ? line.split(' ')[0] : line.slice(0, brace);
    if (name !== metric) continue;
    if (Object.entries(labels).some(([k, v]) => !line.includes(`${k}="${v}"`))) continue;
    sum += Number(line.split(' ').pop());
  }
  return sum;
}

export async function pollTrace(
  tracesUrl: string,
  traceId: string,
  timeoutMs = 10_000,
): Promise<{ spans: JaegerSpan[]; raw: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const res = await fetch(`${tracesUrl}/api/traces/${traceId}`);
    const body = (await res.json()) as { data?: Array<{ spans?: JaegerSpan[] }> };
    last = body;
    const spans = body.data?.[0]?.spans ?? [];
    if (spans.length > 0) return { spans, raw: body };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`trace ${traceId} not in the collector after ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

export type JaegerSpan = {
  traceID: string;
  spanID: string;
  operationName?: string;
  references?: Array<{ refType: string; traceID: string; spanID: string }>;
  tags?: Array<{ key: string; type?: string; value?: unknown }>;
};

export function spanHasError(span: JaegerSpan): boolean {
  return (span.tags ?? []).some(
    (t) =>
      (t.key === 'error' && t.value === true) ||
      (t.key === 'otel.status_code' && String(t.value).toUpperCase() === 'ERROR'),
  );
}

function padSpanId(id: string): string {
  return id.toLowerCase().replace(/-/g, '').padStart(16, '0');
}

export function orphanCount(spans: JaegerSpan[], remoteParentId?: string): number {
  const ids = new Set(spans.map((s) => padSpanId(s.spanID)));
  const remote = remoteParentId ? padSpanId(remoteParentId) : undefined;
  let orphans = 0;
  for (const span of spans) {
    const parent = span.references?.find((r) => r.refType === 'CHILD_OF')?.spanID;
    if (!parent || /^0+$/.test(parent)) continue;
    const padded = padSpanId(parent);
    if (ids.has(padded) || padded === remote) continue;
    orphans += 1;
  }
  return orphans;
}
