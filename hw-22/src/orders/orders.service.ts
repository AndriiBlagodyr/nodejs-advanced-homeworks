import { Injectable, NotFoundException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, MoreThan } from 'typeorm';
import { Order, type OrderStatus } from '../entities/order.entity';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { OrderEventsService } from './order-events.service';
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

  async findAll(limit = 20, cursor?: string): Promise<OrderPage> {
    const where: Record<string, unknown> = {};
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

  async findOne(id: number): Promise<OrderResponse> {
    const order = await this.orderRepo.findOne({
      where: { id: String(id) } as any,
      relations: ['items'],
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return this.toResponse(order);
  }

  async updateStatus(id: number, status: OrderStatus): Promise<OrderResponse> {
    const order = await this.findEntity(id);
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
