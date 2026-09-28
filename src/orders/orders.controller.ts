import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Subscription } from 'rxjs';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './create-order.dto';
import { UpdateOrderStatusDto } from './update-order-status.dto';
import { OrderEventsService, type OrderStatusEvent } from './order-events.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly orderEvents: OrderEventsService,
  ) {}

  @Get()
  listOrders(
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.orders.findAll(limit ?? 20, cursor);
  }

  @Get(':orderId/events')
  async orderEventsStream(
    @Param('orderId', ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.orders.findEntity(id);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');

    const lastEventId = Number(req.headers['last-event-id'] ?? 0);
    const replayFrom = Number.isFinite(lastEventId) ? lastEventId : 0;
    for (const event of this.orderEvents.historyAfter(id, replayFrom)) {
      writeSse(res, event);
    }

    const sub: Subscription = this.orderEvents.stream(id).subscribe((event) => {
      writeSse(res, event);
    });

    const onClose = () => {
      sub.unsubscribe();
      res.end();
    };
    req.on('close', onClose);
  }

  @Get(':orderId')
  getOrder(@Param('orderId', ParseIntPipe) id: number) {
    return this.orders.findOne(id);
  }

  @Patch(':orderId/status')
  updateStatus(
    @Param('orderId', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orders.updateStatus(id, dto.status);
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

function writeSse(res: Response, event: OrderStatusEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: order.status\n`);
  res.write(
    `data: ${JSON.stringify({ orderId: event.orderId, status: event.status })}\n\n`,
  );
}
