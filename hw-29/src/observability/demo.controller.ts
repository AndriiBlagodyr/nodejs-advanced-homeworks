import { Controller, Get, Header, HttpCode, InternalServerErrorException, Post, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { DataSource } from 'typeorm';
import { forceFlush } from './instrumentation';
import { childLogger } from './logger';
import { register } from './metrics';

@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): Promise<string> {
    return register.metrics();
  }
}

const log = childLogger('demo.controller');
const serviceLog = childLogger('demo.service');
const repoLog = childLogger('demo.repo');
const tracer = trace.getTracer('marketplace-api');

@Controller('demo')
export class DemoController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Always 5xx: OTel leaves 4xx Unset, so the ERROR status has to come from here. */
  @Get('fail')
  async fail(@Query('delay_ms') delayMs?: number): Promise<never> {
    log.info({ delayMs: delayMs ?? 0 }, 'forced failure');
    return this.boom(Number(delayMs) || 0);
  }

  @Post('flush')
  @HttpCode(200)
  async flush(): Promise<{ ok: true }> {
    await forceFlush();
    return { ok: true };
  }

  private async boom(delayMs: number): Promise<never> {
    serviceLog.info({ delayMs }, 'boom');
    await tracer.startActiveSpan('demo.repo.ping', async (span) => {
      try {
        repoLog.info({ delayMs }, 'ping');
        await this.ds.query('SELECT 1');
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'forced 500' });
      } finally {
        span.end();
      }
    });
    throw new InternalServerErrorException('forced');
  }
}
