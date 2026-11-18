import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where Prometheus, running in compose, can reach this process.
 * `METRICS_TARGET` is a full `host:port` when the operator already knows it.
 * Otherwise the host comes from `METRICS_TARGET_HOST` and the port is the one
 * this process actually bound — demos listen on port 0, so a baked-in `:3000`
 * never sees their traffic.
 */
export function metricsTarget(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.METRICS_TARGET?.trim();
  if (explicit) return explicit;
  const host = env.METRICS_TARGET_HOST?.trim() || 'host.docker.internal';
  return `${host}:${port}`;
}

export function metricsTargetFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.METRICS_SD_FILE?.trim() || join(process.cwd(), 'observability', 'sd', 'targets.json');
}

/**
 * Scrape time of the last successful pull. An instant query stamps `up` with
 * the evaluation time, so the timestamp has to come back as the sample value.
 */
export function scrapeStampQuery(target: string): string {
  // `==` would restamp the sample at evaluation time. `and` keeps the scrape time.
  return `timestamp(up{instance="${target}"}) and on(instance) (up{instance="${target}"} == 1)`;
}

/**
 * Stay reachable until Prometheus has scraped this process at a time strictly
 * after `after` (0 waits for the first scrape). A miss does not fail the demo.
 * Returns the scrape timestamp in seconds, or 0 when Prometheus never answered.
 */
export async function holdForScrape(
  port: number,
  after = 0,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const base = env.PROMETHEUS_URL?.trim();
  if (!base) return 0;
  const query = scrapeStampQuery(metricsTarget(port, env));
  const deadline = Date.now() + 8_000;
  let stamp = 0;
  while (Date.now() < deadline) {
    try {
      const url = new URL('/api/v1/query', base.endsWith('/') ? base : `${base}/`);
      url.searchParams.set('query', query);
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { data?: { result?: { value?: [number, string] }[] } };
        const sample = body.data?.result?.[0]?.value;
        if (sample) stamp = Number(sample[1]);
        if (stamp > after) return stamp;
      }
    } catch {
      // Prometheus is still starting, or this run has no stand.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return stamp;
}

/**
 * One counted request, then a scrape that sees it. The following scrape, after
 * the demo traffic, is what makes `rate()` non-zero: both samples have to
 * contain the counter, and the second has to be higher.
 */
export async function scrapeBeforeTraffic(base: string, port: number): Promise<number> {
  const armed = await holdForScrape(port);
  await fetch(`${base}/products/900000`).catch(() => undefined);
  return holdForScrape(port, armed);
}

/**
 * One scrape sees the demo traffic. A series that first appears there (a 500)
 * still has only one sample, and `rate()` skips it. One more counted request,
 * then a second scrape, gives that series an increase.
 */
export async function scrapeAfterTraffic(base: string, port: number, after: number): Promise<void> {
  const seen = await holdForScrape(port, after);
  const path = process.env.DEMO_ROUTES === '1' ? '/demo/fail?delay_ms=800' : '/products/900000';
  await fetch(`${base}${path}`).catch(() => undefined);
  await holdForScrape(port, seen);
}

/** file_sd document. Prometheus re-reads it; a failure to write must not stop the process. */
export function publishMetricsTarget(port: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = metricsTargetFile(env);
    mkdirSync(dirname(file), { recursive: true });
    const body = JSON.stringify([{ targets: [metricsTarget(port, env)], labels: { job: 'api' } }]);
    writeFileSync(file, `${body}\n`);
  } catch {
    // The cluster image has a read-only root and no local Prometheus.
  }
}
