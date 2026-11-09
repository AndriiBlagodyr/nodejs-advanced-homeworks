import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export type OrderStatusEvent = {
  id: number;
  orderId: number;
  status: string;
  at: string;
};

const BUFFER_LIMIT = 100;

@Injectable()
export class OrderEventsService {
  private seq = 0;
  private readonly buffers = new Map<number, OrderStatusEvent[]>();
  private readonly subject = new Subject<OrderStatusEvent>();

  publish(orderId: number, status: string): OrderStatusEvent {
    const event: OrderStatusEvent = {
      id: ++this.seq,
      orderId,
      status,
      at: new Date().toISOString(),
    };
    const buf = this.buffers.get(orderId) ?? [];
    buf.push(event);
    if (buf.length > BUFFER_LIMIT) buf.shift();
    this.buffers.set(orderId, buf);
    this.subject.next(event);
    return event;
  }

  historyAfter(orderId: number, lastEventId: number): OrderStatusEvent[] {
    return (this.buffers.get(orderId) ?? []).filter((e) => e.id > lastEventId);
  }

  streamAll(): Observable<OrderStatusEvent> {
    return this.subject.asObservable();
  }

  stream(orderId: number): Observable<OrderStatusEvent> {
    return this.subject.asObservable().pipe(filter((e) => e.orderId === orderId));
  }
}
