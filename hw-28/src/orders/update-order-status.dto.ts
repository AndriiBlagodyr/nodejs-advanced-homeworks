import { IsIn } from 'class-validator';
import { ORDER_STATUSES, type OrderStatus } from '../entities/order.entity';

export class UpdateOrderStatusDto {
  @IsIn(ORDER_STATUSES)
  status: OrderStatus;
}
