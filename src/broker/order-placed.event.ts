export type OrderPlacedEvent = {
  eventId: string;
  type: 'order.placed';
  occurredAt: string;
  data: {
    orderId: string;
    userId: string;
    totalCents: number;
  };
};

export function orderPlacedEvent(input: {
  orderId: string;
  userId: string;
  totalCents: number;
}): OrderPlacedEvent {
  return {
    eventId: `order.placed:${input.orderId}`,
    type: 'order.placed',
    occurredAt: new Date().toISOString(),
    data: {
      orderId: String(input.orderId),
      userId: String(input.userId),
      totalCents: input.totalCents,
    },
  };
}
