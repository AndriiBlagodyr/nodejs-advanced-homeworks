import {
  Body,
  Controller,
  Get,
  HttpException,
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
    const userId = sseUserId(req);
    try {
      await this.orders.requireOwner(id, userId);
    } catch (err) {
      if (err instanceof HttpException) {
        res.status(err.getStatus()).json(err.getResponse());
        return;
      }
      throw err;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');

    const rawLastId = req.headers['last-event-id'];
    const lastEventHeader = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
    if (lastEventHeader !== undefined && lastEventHeader !== '') {
      const lastEventId = Number(lastEventHeader);
      if (Number.isFinite(lastEventId)) {
        for (const event of this.orderEvents.historyAfter(id, lastEventId)) {
          writeSse(res, event);
        }
      }
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

function sseUserId(req: Request): string | undefined {
  const fromQuery = req.query.userId;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) {
    return fromQuery;
  }
  const fromHeader = req.headers['x-user-id'];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) {
    return fromHeader;
  }
  return undefined;
}

function writeSse(res: Response, event: OrderStatusEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: order.status\n`);
  res.write(
    `data: ${JSON.stringify({ orderId: event.orderId, status: event.status })}\n\n`,
  );
}
