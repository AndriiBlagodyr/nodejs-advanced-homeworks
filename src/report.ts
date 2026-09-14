import { DataSource } from 'typeorm';
import { createDataSourceOptions } from './data-source';
import { Order } from './entities';

type RevenueByCountryRow = {
  country: string;
  order_count: string;
  revenue_cents: string;
};

async function main(): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();

  try {
    const rows = await ds
      .getRepository(Order)
      .createQueryBuilder('order')
      .innerJoin('order.items', 'item')
      .select('order.shipping_country', 'country')
      .addSelect('COUNT(DISTINCT order.id)', 'order_count')
      .addSelect('SUM(item.line_total_cents)', 'revenue_cents')
      .groupBy('order.shipping_country')
      .orderBy('SUM(item.line_total_cents)', 'DESC')
      .getRawMany<RevenueByCountryRow>();

    console.log('Revenue by shipping country');
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
