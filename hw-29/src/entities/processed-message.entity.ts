import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'processed_messages' })
export class ProcessedMessage {
  @PrimaryColumn({ type: 'text', name: 'message_id' })
  messageId: string;

  @PrimaryColumn({ type: 'text' })
  consumer: string;

  @Column({ type: 'timestamptz', name: 'processed_at', default: () => 'now()' })
  processedAt: Date;
}
