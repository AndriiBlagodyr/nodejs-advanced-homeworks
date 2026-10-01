import { Injectable } from '@nestjs/common';
import { connectBroker } from './connection';
import type { OrderPlacedEvent } from './order-placed.event';
import { publishOrderPlaced } from './publisher';

@Injectable()
export class OrderPlacedPublisher {
  async publish(event: OrderPlacedEvent): Promise<void> {
    if (!process.env.BROKER_URL && !process.env.RABBITMQ_URL) {
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
