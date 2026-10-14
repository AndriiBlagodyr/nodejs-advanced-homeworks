import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderEventsService } from './order-events.service';
import { OrdersGateway } from './orders.gateway';
import { OrderPlacedPublisher } from '../broker/order-placed.publisher';

@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderItem, Product, User])],
  providers: [OrdersService, OrderEventsService, OrdersGateway, OrderPlacedPublisher],
  controllers: [OrdersController],
})
export class OrdersModule {}
