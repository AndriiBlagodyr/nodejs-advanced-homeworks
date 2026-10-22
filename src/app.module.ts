import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createDataSourceOptions } from './data-source';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { redisConfigured } from './redis/clients';
import { RedisFeaturesModule } from './redis/redis-features.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...createDataSourceOptions(),
        autoLoadEntities: false,
        retryAttempts: 3,
        retryDelay: 1000,
      }),
    }),
    AuthModule,
    ProductsModule,
    OrdersModule,
    ...(redisConfigured() ? [RedisFeaturesModule] : []),
  ],
})
export class AppModule {}
