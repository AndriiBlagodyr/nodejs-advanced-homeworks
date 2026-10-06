import { Injectable, Logger } from '@nestjs/common';
import { connectBroker } from './connection';
import type { OrderPlacedEvent } from './order-placed.event';
import { publishOrderPlaced } from './publisher';

@Injectable()
export class OrderPlacedPublisher {
  private readonly logger = new Logger(OrderPlacedPublisher.name);

  async publish(event: OrderPlacedEvent): Promise<void> {
    if (!process.env.BROKER_URL && !process.env.RABBITMQ_URL) {
      this.logger.warn(
        `BROKER_URL is unset; skipping order.placed publish (eventId=${event.eventId})`,
      );
      return;
    }
    const conn = await connectBroker();
    const ch = await conn.createConfirmChannel();
    try {
      await publishOrderPlaced(ch, event);
    } finally {
      await ch.close();
      await conn.close();
    }
  }
}
