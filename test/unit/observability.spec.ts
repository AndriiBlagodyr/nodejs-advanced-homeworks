import pino from 'pino';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DURATION_BUCKETS_SECONDS, TOP_FINITE_BUCKET_SECONDS } from '../../src/observability/config';
import { censorSecrets, REDACTED } from '../../src/observability/logger';
import { routeTemplate } from '../../src/observability/metrics';
import { metricsTarget, publishMetricsTarget, scrapeStampQuery } from '../../src/observability/metrics-target';
import { demoRoutesEnabled } from '../../src/observability/observability.module';
import { hasRoute, rawIdRoute } from '../../src/demos/observe-kit';

describe('observability policy', () => {
  it('keeps the top finite histogram bucket above a 800 ms demo request', () => {
    expect(TOP_FINITE_BUCKET_SECONDS).toBe(DURATION_BUCKETS_SECONDS.at(-1));
    expect(TOP_FINITE_BUCKET_SECONDS).toBeGreaterThan(0.8);
    expect(DURATION_BUCKETS_SECONDS.every((b, i, all) => i === 0 || b > all[i - 1])).toBe(true);
  });

  it('tells a template route from a raw id', () => {
    const text = 'http_requests_total{method="GET",route="/products/:productId",status="404"} 1\n';
    expect(hasRoute(text, '/products/:productId')).toBe(true);
    expect(rawIdRoute(text)).toBe(false);
    expect(rawIdRoute('http_requests_total{route="/products/900001",status="404"} 1')).toBe(true);
  });

  it('uses the route template, not the raw path', () => {
    const req = {
      baseUrl: '/products',
      route: { path: '/:productId' },
      path: '/products/900042',
    } as any;
    expect(routeTemplate(req)).toBe('/products/:productId');
    expect(routeTemplate({ baseUrl: '', route: undefined } as any)).toBe('unmatched');
  });

  it('masks a secret by key name at any depth and keeps an ordinary field', () => {
    const lines: string[] = [];
    const log = pino(
      {
        formatters: {
          log(object) {
            return censorSecrets(object) as Record<string, unknown>;
          },
        },
      },
      { write: (s: string) => lines.push(s) },
    );
    log.info(
      {
        req: {
          headers: { authorization: 'Bearer hw29-secret-token-aaaaaaaa' },
          body: {
            password: 'hw29-secret-password-bbbbbbbb',
            email: 'ada@example.com',
            nested: { token: 'not-on-any-path', note: 'keep-me' },
            client_secret: 'client-secret-value',
          },
        },
        trace_id: 'abc',
        userId: 'user-1',
      },
      'request',
    );
    const dumped = lines.join('');
    expect(dumped).toContain(REDACTED);
    expect(dumped).not.toContain('hw29-secret-token-aaaaaaaa');
    expect(dumped).not.toContain('hw29-secret-password-bbbbbbbb');
    expect(dumped).not.toContain('not-on-any-path');
    expect(dumped).not.toContain('client-secret-value');
    expect(dumped).toContain('ada@example.com');
    expect(dumped).toContain('keep-me');
    expect(dumped).toContain('user-1');
    expect(censorSecrets({ trace_id: 'abc', idempotencyKey: 'k' })).toEqual({
      trace_id: 'abc',
      idempotencyKey: 'k',
    });
  });

  it('mounts the demo routes only when DEMO_ROUTES=1', () => {
    expect(demoRoutesEnabled({ DEMO_ROUTES: '1' })).toBe(true);
    expect(demoRoutesEnabled({})).toBe(false);
    expect(demoRoutesEnabled({ DEMO_ROUTES: 'true' })).toBe(false);
  });

  it('builds the scrape address from the environment and the bound port', () => {
    expect(metricsTarget(49123, {})).toBe('host.docker.internal:49123');
    expect(metricsTarget(49123, { METRICS_TARGET_HOST: 'api.internal' })).toBe('api.internal:49123');
    expect(metricsTarget(49123, { METRICS_TARGET: 'prom-can-see-me:3000' })).toBe('prom-can-see-me:3000');
    expect(scrapeStampQuery('host.docker.internal:49123')).toBe(
      'timestamp(up{instance="host.docker.internal:49123"}) and on(instance) (up{instance="host.docker.internal:49123"} == 1)',
    );

    const dir = mkdtempSync(join(tmpdir(), 'hw29-sd-'));
    const file = join(dir, 'targets.json');
    publishMetricsTarget(49123, { METRICS_SD_FILE: file, METRICS_TARGET_HOST: 'host.docker.internal' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
      { targets: ['host.docker.internal:49123'], labels: { job: 'api' } },
    ]);
  });
});
