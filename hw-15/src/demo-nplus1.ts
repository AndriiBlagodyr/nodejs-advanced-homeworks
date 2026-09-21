import { DataSource, In } from 'typeorm';
import { createDataSourceOptions } from './data-source';
import { Order, OrderItem, Product } from './entities';
import { QueryCountLogger } from './query-count-logger';

function parseSampleSize(raw: string | undefined): number {
  const value = Number(raw ?? 8);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`N must be a positive integer, got: ${raw ?? ''}`);
  }
  return value;
}

async function loadSampleOrderIds(
  ds: DataSource,
  sampleSize: number,
): Promise<string[]> {
  const orders = await ds.getRepository(Order).find({
    select: ['id'],
    take: sampleSize,
    order: { id: 'ASC' },
  });
  return orders.map((order) => order.id);
}

async function runNaive(ds: DataSource, ids: string[]): Promise<void> {
  const orders = await ds.getRepository(Order).find({
    where: { id: In(ids) },
    order: { id: 'ASC' },
  });

  for (const order of orders) {
    const items = await ds.getRepository(OrderItem).find({
      where: { orderId: order.id },
    });
    for (const item of items) {
      await ds.getRepository(Product).findOneByOrFail({ id: item.productId });
    }
  }
}

async function runFixedJoin(ds: DataSource, ids: string[]): Promise<void> {
  await ds
    .getRepository(Order)
    .createQueryBuilder('order')
    .leftJoinAndSelect('order.items', 'item')
    .leftJoinAndSelect('item.product', 'product')
    .where('order.id IN (:...ids)', { ids })
    .orderBy('order.id', 'ASC')
    .getMany();
}

async function runFixedQueryStrategy(
  ds: DataSource,
  ids: string[],
): Promise<void> {
  await ds.getRepository(Order).find({
    where: { id: In(ids) },
    order: { id: 'ASC' },
    relations: { items: { product: true } },
    relationLoadStrategy: 'query',
  });
}

async function measure(
  label: string,
  ids: string[],
  run: (ds: DataSource, ids: string[]) => Promise<void>,
): Promise<number> {
  const logger = new QueryCountLogger();
  const ds = new DataSource(
    createDataSourceOptions({
      logging: ['query'],
      logger,
    }),
  );
  await ds.initialize();
  logger.count = 0;
  try {
    await run(ds, ids);
    console.log(`\n=== ${label} ===`);
    console.log(`SQL queries: ${logger.count}`);
    return logger.count;
  } finally {
    await ds.destroy();
  }
}

async function main(): Promise<void> {
  const sampleSize = parseSampleSize(process.argv[2]);

  const bootstrap = new DataSource(createDataSourceOptions());
  await bootstrap.initialize();
  const ids = await loadSampleOrderIds(bootstrap, sampleSize);
  await bootstrap.destroy();

  if (ids.length < sampleSize) {
    throw new Error(
      `Need at least ${sampleSize} orders for N=${sampleSize}, found ${ids.length}`,
    );
  }

  console.log(
    `N+1 demo on graph order → items → product (N=${sampleSize}, ids=${ids.join(',')})`,
  );

  const naive = await measure('naive (query per order / item)', ids, runNaive);
  const joined = await measure('leftJoinAndSelect', ids, runFixedJoin);
  const queryStrategy = await measure(
    "relationLoadStrategy: 'query'",
    ids,
    runFixedQueryStrategy,
  );

  console.log('\nN+1 query counts');
  console.log(`N (orders)                    ${sampleSize}`);
  console.log(`naive (loop)                  ${naive}`);
  console.log(`leftJoinAndSelect             ${joined}`);
  console.log(`relationLoadStrategy: query   ${queryStrategy}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
