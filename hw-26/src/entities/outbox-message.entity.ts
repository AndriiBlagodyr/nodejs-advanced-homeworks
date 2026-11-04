import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'outbox' })
// Partial index (WHERE published_at IS NULL) lives in the migration.
@Index('idx_outbox_unpublished', { synchronize: false })
export class OutboxMessage {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'text', name: 'aggregate_type' })
  aggregateType: string;

  @Column({ type: 'text', name: 'aggregate_id' })
  aggregateId: string;

  @Column({ type: 'text' })
  type: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError: string | null;
}
