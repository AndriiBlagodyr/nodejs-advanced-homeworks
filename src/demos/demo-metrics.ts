import '../observability/instrumentation';
import { takeLogLines } from '../observability/log-buffer';
import { bootApi, migrate } from './auth-kit';
import { fail, report } from './demo-kit';
import {
  aboveTopBucket,
  counterSeries,
  counterTotal,
  errorsTotal,
  hasRoute,
  rawIdRoute,
  scrapeMetrics,
  send,
} from './observe-kit';

const CARDINALITY = 100;
const OK = 40;
const FAIL = 15;
const SLOW_MS = 800;

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
  // Warm the template with a missing id so 100 other missing ids cannot add a series.
  await send(base, '/products/900000');
  const beforeText = await scrapeMetrics(base);
  const seriesBefore = counterSeries(beforeText);

  await Promise.all(
    Array.from({ length: CARDINALITY }, (_, i) => send(base, `/products/${900000 + i}`)),
  );
  const afterCard = await scrapeMetrics(base);
  const seriesAfter = counterSeries(afterCard);

  const mid = afterCard;
  const midTotal = counterTotal(mid);
  const midErrors = errorsTotal(mid);

  const oks = await Promise.all(Array.from({ length: OK }, () => send(base, '/products')));
  const fails = await Promise.all(Array.from({ length: FAIL }, () => send(base, '/demo/fail')));
  await send(base, `/demo/fail?delay_ms=${SLOW_MS}`);
  const sentFail = fails.filter((r) => r.status >= 500).length + 1;
  const sentOk = oks.filter((r) => r.status < 400).length;

  const end = await scrapeMetrics(base);
  const lines = {
    'sent-ok': sentOk,
    'sent-fail': sentFail,
    'counter-delta': counterTotal(end) - midTotal,
    'errors-delta': errorsTotal(end) - midErrors,
    'above-top-bucket': aboveTopBucket(end, '/demo/fail'),
    'series-before': seriesBefore,
    'series-after': seriesAfter,
  };
  return {
    lines,
    ok:
      lines['sent-ok'] + lines['sent-fail'] >= 50 &&
      lines['counter-delta'] === lines['sent-ok'] + lines['sent-fail'] &&
      lines['errors-delta'] === lines['sent-fail'] &&
      lines['above-top-bucket'] === 0 &&
      lines['series-after'] === lines['series-before'] &&
      hasRoute(afterCard, '/products/:productId') &&
      hasRoute(end, '/demo/fail') &&
      !rawIdRoute(afterCard),
  };
}

main().catch(fail);
