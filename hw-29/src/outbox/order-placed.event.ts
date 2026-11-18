export const ORDER_AGGREGATE = 'order';
export const ORDER_PLACED = 'order.placed';

export type OrderPlacedEvent = {
  eventId: string;
  type: typeof ORDER_PLACED;
  version: 1;
  occurredAt: string;
  data: {
    orderId: string;
    userId: string;
    totalCents: number;
    shippingCountry: string;
    items: Array<{ productId: string; quantity: number; unitPriceCents: number }>;
  };
};

export type PlacedOrder = {
  orderId: string;
  userId: string;
  totalCents: number;
  shippingCountry: string;
  createdAt: Date;
  items: Array<{
    productId: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }>;
};

/** Public contract: DB column names never leak into the event. */
export function toOrderPlacedEvent(eventId: string, order: PlacedOrder): OrderPlacedEvent {
  return {
    eventId,
    type: ORDER_PLACED,
    version: 1,
    occurredAt: order.createdAt.toISOString(),
    data: {
      orderId: order.orderId,
      userId: order.userId,
      totalCents: order.totalCents,
      shippingCountry: order.shippingCountry,
      items: order.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
      })),
    },
  };
}

export function parseOrderPlacedEvent(raw: Buffer): OrderPlacedEvent | null {
  try {
    const body = JSON.parse(raw.toString()) as Partial<OrderPlacedEvent>;
    if (
      body.type !== ORDER_PLACED ||
      typeof body.eventId !== 'string' ||
      body.eventId.length === 0 ||
      !body.data ||
      typeof body.data.orderId !== 'string' ||
      typeof body.data.userId !== 'string' ||
      typeof body.data.totalCents !== 'number'
    ) {
      return null;
    }
    return body as OrderPlacedEvent;
  } catch {
    return null;
  }
}
