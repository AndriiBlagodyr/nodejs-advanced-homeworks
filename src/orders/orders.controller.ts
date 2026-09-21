import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './create-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  listOrders(
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.orders.findAll(limit ?? 20, cursor);
  }

  @Get(':orderId')
  getOrder(@Param('orderId', ParseIntPipe) id: number) {
    return this.orders.findOne(id);
  }

  @Post()
  async createOrder(
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const DEFAULT_USER_ID = '1';
    const order = await this.orders.create(dto.items, DEFAULT_USER_ID);
    res.status(HttpStatus.CREATED);
    res.setHeader('Location', `/orders/${order.id}`);
    return order;
  }
}
