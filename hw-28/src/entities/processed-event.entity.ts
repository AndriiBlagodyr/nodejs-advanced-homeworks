import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'processed_events' })
export class ProcessedEvent {
  @PrimaryColumn({ type: 'text', name: 'event_id' })
  eventId: string;

  @Column({
    type: 'timestamptz',
    name: 'applied_at',
    default: () => 'now()',
  })
  appliedAt: Date;
}
