import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  listProducts(
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.products.findAll(limit ?? 20, cursor);
  }

  @Get(':productId')
  getProduct(@Param('productId', ParseIntPipe) id: number) {
    return this.products.findOne(id);
  }
}
