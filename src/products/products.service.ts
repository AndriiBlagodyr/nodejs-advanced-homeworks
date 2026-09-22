import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Product } from '../entities/product.entity';

export interface ProductPage {
  items: Array<{ id: number; name: string; price_cents: number }>;
  next_cursor: string | null;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly repo: Repository<Product>,
  ) {}

  async findAll(limit = 20, cursor?: string): Promise<ProductPage> {
    const where: Record<string, unknown> = { isActive: true };
    if (cursor) {
      where.id = MoreThan(Number(cursor));
    }

    const products = await this.repo.find({
      where,
      order: { id: 'ASC' },
      take: limit + 1,
    });

    const hasMore = products.length > limit;
    const items = (hasMore ? products.slice(0, limit) : products).map((p) => ({
      id: Number(p.id),
      name: p.name,
      price_cents: p.priceCents,
    }));

    return {
      items,
      next_cursor: hasMore ? String(items[items.length - 1].id) : null,
    };
  }

  async findOne(id: number): Promise<{ id: number; name: string; price_cents: number }> {
    const p = await this.repo.findOne({ where: { id: String(id) } as any });
    if (!p) throw new NotFoundException(`Product ${id} not found`);
    return { id: Number(p.id), name: p.name, price_cents: p.priceCents };
  }
}
