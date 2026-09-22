import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createDataSourceOptions } from './data-source';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';

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
    ProductsModule,
    OrdersModule,
  ],
})
export class AppModule {}
