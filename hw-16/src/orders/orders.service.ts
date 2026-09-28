import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, MoreThan } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';

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

  async findOne(id: number): Promise<OrderResponse> {
    const order = await this.orderRepo.findOne({
      where: { id: String(id) } as any,
      relations: ['items'],
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return this.toResponse(order);
  }

  async create(
    orderItems: OrderItemInput[],
    userId: string,
    shippingCountry = 'US',
  ): Promise<OrderResponse> {
    return this.dataSource.transaction(async (manager) => {
      let totalCents = 0;
      const itemsData: Array<{
        productId: string;
        quantity: number;
        unitPriceCents: number;
        lineTotalCents: number;
      }> = [];

      for (const item of orderItems) {
        const product = await manager.findOne(Product, {
          where: { id: String(item.product_id) } as any,
        });
        if (!product) {
          throw new NotFoundException(`Product ${item.product_id} not found`);
        }
        if (product.stock < item.quantity) {
          throw new BadRequestException(
            `Insufficient stock for product ${item.product_id}`,
          );
        }

        const lineTotalCents = product.priceCents * item.quantity;
        totalCents += lineTotalCents;

        await manager.decrement(
          Product,
          { id: product.id } as any,
          'stock',
          item.quantity,
        );

        itemsData.push({
          productId: product.id,
          quantity: item.quantity,
          unitPriceCents: product.priceCents,
          lineTotalCents,
        });
      }

      const order = manager.create(Order, {
        userId,
        status: 'completed' as const,
        totalCents,
        shippingCountry,
      });
      const saved = await manager.save(Order, order);

      const items: OrderItem[] = [];
      for (const d of itemsData) {
        const oi = manager.create(OrderItem, {
          orderId: saved.id,
          productId: d.productId,
          quantity: d.quantity,
          unitPriceCents: d.unitPriceCents,
          lineTotalCents: d.lineTotalCents,
        });
        items.push(await manager.save(OrderItem, oi));
      }

      saved.items = items;
      return this.toResponse(saved);
    });
  }
}
