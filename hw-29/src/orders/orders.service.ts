import { Injectable, NotFoundException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, MoreThan } from 'typeorm';
import { Order, type OrderStatus } from '../entities/order.entity';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { OrderEventsService } from './order-events.service';
import type { AccessClaims } from '../auth/tokens';
import { placeOrder, type PlaceOrderResult } from './place-order';

export interface OrderItemInput {
  product_id: number;
  quantity: number;
}

export interface OrderItemResponse {
  product_id: number;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export interface OrderResponse {
  id: number;
  items: OrderItemResponse[];
  total_cents: number;
  created_at: string;
}

export interface OrderPage {
  items: OrderResponse[];
  next_cursor: string | null;
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly orderEvents: OrderEventsService,
  ) {}

  private toResponse(order: Order): OrderResponse {
    return {
      id: Number(order.id),
      items: (order.items ?? []).map((i) => ({
        product_id: Number(i.productId),
        quantity: i.quantity,
        unit_price_cents: i.unitPriceCents,
        line_total_cents: i.lineTotalCents,
      })),
      total_cents: order.totalCents,
      created_at: order.createdAt.toISOString(),
    };
  }

  /**
   * A list has no "someone else's row" to refuse, so ownership goes straight
   * into the WHERE: a buyer's page only ever contains their own orders.
   */
  async findAllForViewer(viewer: AccessClaims, limit = 20, cursor?: string): Promise<OrderPage> {
    const where: Record<string, unknown> = {};
    if (viewer.role !== 'admin') where.userId = viewer.sub;
    if (cursor) {
      where.id = MoreThan(Number(cursor));
    }

    const orders = await this.orderRepo.find({
      where,
      relations: ['items'],
      order: { id: 'ASC' },
      take: limit + 1,
    });

    const hasMore = orders.length > limit;
    const items = (hasMore ? orders.slice(0, limit) : orders).map((o) =>
      this.toResponse(o),
    );

    return {
      items,
      next_cursor: hasMore ? String(items[items.length - 1].id) : null,
    };
  }

  async findEntity(id: number): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: { id: String(id) } as any,
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  /**
   * Shared owner gate for WS join and SSE — runs before any event bus access.
   */
  async requireOwner(orderId: number, userId: string | undefined | null): Promise<Order> {
    if (!userId) {
      throw new UnauthorizedException('unauthorized');
    }
    const order = await this.findEntity(orderId);
    if (String(order.userId) !== String(userId)) {
      throw new ForbiddenException('forbidden');
    }
    return order;
  }

  /**
   * Ownership is checked here, after the row is loaded, not in a guard.
   * The guard has the token and nothing else; it would have to query the
   * order itself and the handler would query it again. A `WHERE user_id = $me`
   * would also hide the row and answer 404, but another buyer's order is 403.
   */
  async findOneForViewer(id: number, viewer: AccessClaims): Promise<OrderResponse> {
    const order = await this.orderRepo.findOne({
      where: { id: String(id) } as any,
      relations: ['items'],
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    if (viewer.role !== 'admin' && String(order.userId) !== viewer.sub) {
      throw new ForbiddenException('forbidden');
    }
    return this.toResponse(order);
  }

  /**
   * An admin may set any status. The owner may only cancel: a buyer marking
   * their own order `completed` or `refunded` is the owner check passing and
   * the permission still missing.
   */
  async updateStatus(id: number, status: OrderStatus, viewer: AccessClaims): Promise<OrderResponse> {
    const order = await this.findEntity(id);
    if (viewer.role !== 'admin') {
      if (String(order.userId) !== viewer.sub) throw new ForbiddenException('forbidden');
      if (status !== 'cancelled') throw new ForbiddenException('only cancellation is allowed');
    }
    order.status = status;
    const saved = await this.orderRepo.save(order);
    this.orderEvents.publish(Number(saved.id), saved.status);
    const withItems = await this.orderRepo.findOne({
      where: { id: saved.id } as any,
      relations: ['items'],
    });
    return this.toResponse(withItems ?? saved);
  }

  create(
    orderItems: OrderItemInput[],
    userId: string,
    idempotencyKey?: string,
    shippingCountry = 'US',
  ): Promise<PlaceOrderResult> {
    return placeOrder(this.dataSource, {
      userId,
      shippingCountry,
      idempotencyKey,
      items: orderItems.map((i) => ({
        productId: String(i.product_id),
        quantity: i.quantity,
      })),
    });
  }
}
