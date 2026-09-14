import {
  Check,
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrderItem } from './order-item.entity';

@Entity({ name: 'products' })
@Check(`length(trim(name)) >= 2`)
@Check(`"price_cents" >= 0`)
export class Product {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'int', name: 'price_cents' })
  priceCents: number;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @Column({
    type: 'timestamptz',
    name: 'created_at',
    default: () => 'now()',
  })
  createdAt: Date;

  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems: OrderItem[];
}
