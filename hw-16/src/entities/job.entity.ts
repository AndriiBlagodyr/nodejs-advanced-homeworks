import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';

export const JOB_TYPES = ['send_receipt'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'done'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

@Entity({ name: 'jobs' })
@Check(`"type" IN ('send_receipt')`)
@Check(`"status" IN ('pending', 'done')`)
@Check(`"processed" >= 0`)
export class Job {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'text' })
  type: JobType;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status: JobStatus;

  /** How many times this job finished processing; must stay 0 or 1. */
  @Column({ type: 'int', default: 0 })
  processed: number;

  @Column({ type: 'text', name: 'worker_id', nullable: true })
  workerId: string | null;

  @Column({ type: 'bigint', name: 'order_id', nullable: true })
  orderId: string | null;

  @ManyToOne(() => Order, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'order_id' })
  order?: Order | null;

  @Column({
    type: 'timestamptz',
    name: 'created_at',
    default: () => 'now()',
  })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'processed_at', nullable: true })
  processedAt: Date | null;
}
