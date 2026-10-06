import type { ConfirmChannel } from 'amqplib';
import { EXCHANGE_EVENTS, ROUTING_ORDER_PLACED } from './constants';
import type { OrderPlacedEvent } from './order-placed.event';

export async function publishOrderPlaced(
  ch: ConfirmChannel,
  event: OrderPlacedEvent,
): Promise<void> {
  const ok = ch.publish(
    EXCHANGE_EVENTS,
    ROUTING_ORDER_PLACED,
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true,
      contentType: 'application/json',
      messageId: event.eventId,
      type: event.type,
    },
  );
  if (!ok) {
    await new Promise<void>((resolve) => ch.once('drain', resolve));
  }
  await ch.waitForConfirms();
}
