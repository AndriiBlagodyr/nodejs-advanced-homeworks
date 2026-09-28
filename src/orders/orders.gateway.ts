import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
    if (!userId) {
      return { ok: false, error: 'unauthorized' };
    }
    if (!Number.isInteger(orderId) || orderId < 1) {
      return { ok: false, error: 'invalid_order' };
    }

    const order = await this.orders.findEntity(orderId);
    if (String(order.userId) !== userId) {
      return { ok: false, error: 'forbidden' };
    }

    const room = `orders:${orderId}`;
    await client.join(room);
    return { ok: true, room };
  }
}
