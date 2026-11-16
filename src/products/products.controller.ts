import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard, RolesGuard } from '../auth/auth.guard';
import { childLogger } from '../observability/logger';
import { CreateProductDto } from './create-product.dto';
import { ProductsService } from './products.service';

const log = childLogger('products.controller');

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

  /** Role gate. A buyer is authenticated and still gets 403; the role is not enough. */
  @Post()
  @HttpCode(201)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  createProduct(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Get(':productId')
  getProduct(@Param('productId', ParseIntPipe) id: number) {
    log.info({ productId: id }, 'get product');
    return this.products.findOne(id);
  }
}
