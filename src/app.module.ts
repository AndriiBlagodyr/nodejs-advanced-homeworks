import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createDataSourceOptions } from './data-source';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { redisConfigured } from './redis/clients';
import { RedisFeaturesModule } from './redis/redis-features.module';
import { FilesModule } from './files/files.module';
import { storageConfigured } from './storage/config';

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
    // `npm run start` refuses to boot without storage (main.ts); tests and the
    // older demos boot AppModule directly and simply have no file endpoints.
    ...(storageConfigured() ? [FilesModule] : []),
  ],
})
export class AppModule {}
