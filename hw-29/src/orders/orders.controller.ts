import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  UseGuards,
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
import { AuthGuard, bearerToken } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/auth.decorators';
import type { AccessClaims } from '../auth/tokens';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './create-order.dto';
import { UpdateOrderStatusDto } from './update-order-status.dto';
import { OrderEventsService, type OrderStatusEvent } from './order-events.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly orderEvents: OrderEventsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  listOrders(
    @CurrentUser() user: AccessClaims,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.orders.findAllForViewer(user, limit ?? 20, cursor);
  }

  /**
   * Not behind @UseGuards: a guard's 401 would be thrown after @Res() took
   * over the response. Same check, done by hand before any headers are sent.
   */
  @Get(':orderId/events')
  async orderEventsStream(
    @Param('orderId', ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = await this.auth.authenticate(sseToken(req));
      await this.orders.requireOwner(id, user.sub);
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
  @UseGuards(AuthGuard)
  getOrder(@Param('orderId', ParseIntPipe) id: number, @CurrentUser() user: AccessClaims) {
    return this.orders.findOneForViewer(id, user);
  }

  @Patch(':orderId/status')
  @UseGuards(AuthGuard)
  updateStatus(
    @Param('orderId', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.orders.updateStatus(id, dto.status, user);
  }

  @Post()
  @UseGuards(AuthGuard)
  async createOrder(
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') rawKey: string | undefined,
    @CurrentUser() user: AccessClaims,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = user.sub;
    const idempotencyKey = rawKey?.trim() || undefined;
    if (idempotencyKey && idempotencyKey.length > 255) {
      throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    }

    const result = await this.orders.create(dto.items, userId, idempotencyKey);
    res.status(result.status ?? HttpStatus.CREATED);
    res.setHeader('Location', `/orders/${result.body.id}`);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}

/**
 * Bearer header first. A browser EventSource cannot set headers, so the same
 * access token may come as ?access_token= (RFC 6750 §2.3); it is short-lived
 * and denylisted on logout like any other.
 */
function sseToken(req: Request): string | undefined {
  const fromHeader = bearerToken(req.headers.authorization);
  if (fromHeader) return fromHeader;
  const fromQuery = req.query.access_token;
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : undefined;
}

function writeSse(res: Response, event: OrderStatusEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: order.status\n`);
  res.write(
    `data: ${JSON.stringify({ orderId: event.orderId, status: event.status })}\n\n`,
  );
}
