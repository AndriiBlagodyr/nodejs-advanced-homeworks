import {
  Check,
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { Order } from './order.entity';

@Entity({ name: 'idempotency_records' })
@Check(`length(request_hash) = 64`)
@Check(`"response_status" BETWEEN 100 AND 599`)
export class IdempotencyRecord {
  @PrimaryColumn({ type: 'text', name: 'idempotency_key' })
  idempotencyKey: string;

  @Column({ type: 'bigint', name: 'order_id', unique: true })
  orderId: string;

  @OneToOne(() => Order, (order) => order.idempotencyRecord, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'char', length: 64, name: 'request_hash' })
  requestHash: string;

  @Column({ type: 'int', name: 'response_status' })
  responseStatus: number;

  @Column({ type: 'jsonb', name: 'response_body' })
  responseBody: Record<string, unknown>;

  @Column({
    type: 'timestamptz',
    name: 'created_at',
    default: () => 'now()',
  })
  createdAt: Date;
}
