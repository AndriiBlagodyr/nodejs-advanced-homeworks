import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DemoController, MetricsController } from './demo.controller';
import { contextMiddleware, metricsMiddleware, requestLogMiddleware } from './http.middleware';

/** `/demo/fail` and `/demo/flush` exist only for the metrics and trace demos. */
export function demoRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_ROUTES === '1';
}

@Module({
  controllers: [MetricsController, ...(demoRoutesEnabled() ? [DemoController] : [])],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(contextMiddleware, metricsMiddleware, requestLogMiddleware).forRoutes('*');
  }
}
