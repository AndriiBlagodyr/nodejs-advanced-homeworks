import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { IdempotencyRecord } from './idempotency-record.entity';
import { OrderItem } from './order-item.entity';
import { User } from './user.entity';

export const ORDER_STATUSES = [
  'pending',
  'completed',
  'cancelled',
  'refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

@Entity({ name: 'orders' })
// INCLUDE / DESC are not expressible in @Index; indexes live in the migration.
@Index('idx_orders_user_created_at', { synchronize: false })
@Index('idx_orders_pending_created_at', { synchronize: false })
@Index('idx_orders_country_status_created_at', { synchronize: false })
@Check(`"status" IN ('pending', 'completed', 'cancelled', 'refunded')`)
@Check(`"total_cents" >= 0`)
@Check(`"shipping_country" ~ '^[A-Z]{2}$'`)
export class Order {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, (user) => user.orders, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'text' })
  status: OrderStatus;

  @Column({ type: 'int', name: 'total_cents' })
  totalCents: number;

  @Column({ type: 'char', length: 2, name: 'shipping_country' })
  shippingCountry: string;

  @Column({
    type: 'timestamptz',
    name: 'created_at',
    default: () => 'now()',
  })
  createdAt: Date;

  @OneToMany(() => OrderItem, (item) => item.order)
  items: OrderItem[];

  @OneToOne(() => IdempotencyRecord, (record) => record.order)
  idempotencyRecord?: IdempotencyRecord;
}
