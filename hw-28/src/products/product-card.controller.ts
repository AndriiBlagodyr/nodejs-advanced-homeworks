import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { ProductCardService } from './product-card';

@Controller('products')
export class ProductCardController {
  constructor(private readonly cards: ProductCardService) {}

  @Get(':productId/card')
  @UseGuards(RateLimitGuard)
  async getCard(@Param('productId', ParseIntPipe) id: number) {
    const card = await this.cards.get(id);
    if (!card) throw new NotFoundException(`Product ${id} not found`);
    return card;
  }
}
