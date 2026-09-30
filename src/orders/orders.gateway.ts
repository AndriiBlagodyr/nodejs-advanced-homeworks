import {
  ForbiddenException,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Subscription } from 'rxjs';
import { OrderEventsService } from './order-events.service';
import { OrdersService } from './orders.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private sub?: Subscription;

  constructor(
    private readonly events: OrderEventsService,
    private readonly orders: OrdersService,
  ) {}

  onModuleInit(): void {
    this.sub = this.events.streamAll().subscribe((event) => {
      this.server.to(`orders:${event.orderId}`).emit('order.status', event);
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  @SubscribeMessage('join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { orderId?: number },
  ): Promise<{ ok: boolean; error?: string; room?: string }> {
    const userId = String(
      client.handshake.auth?.userId ?? client.handshake.query?.userId ?? '',
    );
    const orderId = Number(body?.orderId);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return { ok: false, error: 'invalid_order' };
    }

    try {
      await this.orders.requireOwner(orderId, userId || undefined);
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        return { ok: false, error: 'unauthorized' };
      }
      if (err instanceof ForbiddenException) {
        return { ok: false, error: 'forbidden' };
      }
      if (err instanceof NotFoundException) {
        return { ok: false, error: 'not_found' };
      }
      throw err;
    }

    const room = `orders:${orderId}`;
    await client.join(room);
    return { ok: true, room };
  }
}
