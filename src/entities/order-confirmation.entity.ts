import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'order_confirmations' })
export class OrderConfirmation {
  @PrimaryColumn({ type: 'bigint', name: 'order_id' })
  orderId: string;

  @Column({ type: 'text', name: 'event_id' })
  eventId: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  @Column({ type: 'int', name: 'total_cents' })
  totalCents: number;

  @Column({ type: 'timestamptz', name: 'confirmed_at', default: () => 'now()' })
  confirmedAt: Date;
}
