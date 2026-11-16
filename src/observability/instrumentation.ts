import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Must load before Nest (npm start uses --require). HTTP instrumentation
 * then patches `http` before the framework imports it, so an incoming
 * `traceparent` becomes the active span the pino mixin reads.
 */
let sdk: NodeSDK | undefined;

function otlpTracesUrl(): string | undefined {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!raw) return undefined;
  const base = raw.replace(/\/$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

export function startInstrumentation(): void {
  if (sdk) return;
  const url = otlpTracesUrl();
  const exporter = url ? new OTLPTraceExporter({ url }) : undefined;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'marketplace-api' }),
    spanProcessors: exporter
      ? [new BatchSpanProcessor({ exporter, scheduledDelayMillis: 200, maxExportBatchSize: 64 })]
      : [],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const path = req.url?.split('?')[0] ?? '';
          return path === '/metrics' || path === '/healthz' || path === '/readyz';
        },
      }),
    ],
  });
  sdk.start();
}

export async function forceFlush(): Promise<void> {
  const provider = trace.getTracerProvider() as {
    forceFlush?: () => Promise<void>;
    getDelegate?: () => { forceFlush?: () => Promise<void> };
  };
  await provider.forceFlush?.();
  await provider.getDelegate?.()?.forceFlush?.();
}

startInstrumentation();
