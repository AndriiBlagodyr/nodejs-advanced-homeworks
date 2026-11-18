export const OTEL_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'PROMETHEUS_URL',
  'TRACE_API_URL',
] as const;

export const GRAFANA_VARS = ['GRAFANA_USER', 'GRAFANA_PASSWORD'] as const;

export function missingObserveVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...OTEL_VARS].filter((name) => !env[name]?.trim());
}

export function loadObserveConfig(env: NodeJS.ProcessEnv = process.env): {
  otlp: string;
  prometheus: string;
  traces: string;
} {
  const missing = missingObserveVars(env);
  if (missing.length > 0) {
    throw new Error(`missing required secret: ${missing.join(', ')} (vault, via scripts/with-secrets.sh)`);
  }
  return {
    otlp: env.OTEL_EXPORTER_OTLP_ENDPOINT!.replace(/\/$/, ''),
    prometheus: env.PROMETHEUS_URL!.replace(/\/$/, ''),
    traces: env.TRACE_API_URL!.replace(/\/$/, ''),
  };
}

/** Finite upper bound of the duration histogram, in seconds. Must exceed the slowest demo request. */
export const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2];
export const TOP_FINITE_BUCKET_SECONDS = DURATION_BUCKETS_SECONDS[DURATION_BUCKETS_SECONDS.length - 1];

export const HTTP_REQUESTS_TOTAL = 'http_requests_total';
export const HTTP_REQUEST_DURATION = 'http_request_duration_seconds';
