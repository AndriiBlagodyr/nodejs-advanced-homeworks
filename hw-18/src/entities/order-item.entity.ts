import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Order } from './order.entity';
import { Product } from './product.entity';

@Entity({ name: 'order_items' })
@Unique('UQ_order_items_order_product', ['order', 'product'])
@Check(`"quantity" BETWEEN 1 AND 100`)
@Check(`"unit_price_cents" >= 0`)
@Check(`"line_total_cents" = "unit_price_cents" * "quantity"`)
export class OrderItem {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'order_id' })
  orderId: string;

  @ManyToOne(() => Order, (order) => order.items, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'bigint', name: 'product_id' })
  productId: string;

  @ManyToOne(() => Product, (product) => product.orderItems, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'int', name: 'unit_price_cents' })
  unitPriceCents: number;

  @Column({ type: 'int', name: 'line_total_cents' })
  lineTotalCents: number;
}
