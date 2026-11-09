import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DemoController, MetricsController } from './demo.controller';
import { contextMiddleware, metricsMiddleware, requestLogMiddleware } from './http.middleware';

@Module({
  controllers: [DemoController, MetricsController],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(contextMiddleware, metricsMiddleware, requestLogMiddleware).forRoutes('*');
  }
}
