import pino from 'pino';
import { DURATION_BUCKETS_SECONDS, TOP_FINITE_BUCKET_SECONDS } from '../../src/observability/config';
import { REDACT_PATHS } from '../../src/observability/logger';
import { routeTemplate } from '../../src/observability/metrics';
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

  it('redacts listed paths and leaves an unlisted nested field', () => {
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: REDACT_PATHS, censor: '[Redacted]' } },
      { write: (s: string) => lines.push(s) },
    );
    log.info(
      {
        req: {
          headers: { authorization: 'Bearer hw29-secret-token-aaaaaaaa' },
          body: { password: 'hw29-secret-password-bbbbbbbb', nested: { token: 'visible-nested' } },
        },
      },
      'request',
    );
    const dumped = lines.join('');
    expect(dumped).toContain('[Redacted]');
    expect(dumped).not.toContain('hw29-secret-token-aaaaaaaa');
    expect(dumped).not.toContain('hw29-secret-password-bbbbbbbb');
    expect(dumped).toContain('visible-nested');
  });
});
