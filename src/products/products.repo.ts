import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { trace } from '@opentelemetry/api';
import { Repository } from 'typeorm';
import { Product } from '../entities/product.entity';
import { childLogger } from '../observability/logger';

const log = childLogger('products.repo');
const tracer = trace.getTracer('marketplace-api');

@Injectable()
export class ProductsRepo {
  constructor(@InjectRepository(Product) private readonly repo: Repository<Product>) {}

  findById(id: number): Promise<Product | null> {
    return tracer.startActiveSpan('products.repo.findById', async (span) => {
      span.setAttribute('product.id', id);
      try {
        log.info({ productId: id }, 'find product');
        return await this.repo.findOne({ where: { id: String(id) } as any });
      } finally {
        span.end();
      }
    });
  }
}
