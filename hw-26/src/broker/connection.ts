import type { ChannelModel } from 'amqplib';
import amqplib from 'amqplib';

export function brokerUrl(): string {
  const url = process.env.BROKER_URL ?? process.env.RABBITMQ_URL;
  if (!url) {
    throw new Error('BROKER_URL: unbound variable');
  }
  return url;
}

export async function connectBroker(): Promise<ChannelModel> {
  return amqplib.connect(brokerUrl());
}
