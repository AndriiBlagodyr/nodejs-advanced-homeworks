import { DataSource } from 'typeorm';
import { createDataSourceOptions } from './data-source';
import { Order, OrderItem, Product } from './entities';
import { QueryCountLogger } from './query-count-logger';

const SAMPLE_SIZE = 8;

async function runNaive(ds: DataSource): Promise<void> {
  const orders = await ds.getRepository(Order).find({
    take: SAMPLE_SIZE,
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

async function runFixedJoin(ds: DataSource): Promise<void> {
  await ds
    .getRepository(Order)
    .createQueryBuilder('order')
    .leftJoinAndSelect('order.items', 'item')
    .leftJoinAndSelect('item.product', 'product')
    .where('order.id IN (:...ids)', {
      ids: Array.from({ length: SAMPLE_SIZE }, (_, index) => String(index + 1)),
    })
    .orderBy('order.id', 'ASC')
    .getMany();
}

async function runFixedQueryStrategy(ds: DataSource): Promise<void> {
  await ds.getRepository(Order).find({
    take: SAMPLE_SIZE,
    order: { id: 'ASC' },
    relations: { items: { product: true } },
    relationLoadStrategy: 'query',
  });
}

async function measure(
  label: string,
  run: (ds: DataSource) => Promise<void>,
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
    await run(ds);
    console.log(`\n=== ${label} ===`);
    console.log(`SQL queries: ${logger.count}`);
    return logger.count;
  } finally {
    await ds.destroy();
  }
}

async function main(): Promise<void> {
  console.log(`N+1 demo on graph order → items → product (N=${SAMPLE_SIZE})`);

  const naive = await measure('naive (query per order / item)', runNaive);
  const joined = await measure('leftJoinAndSelect', runFixedJoin);
  const queryStrategy = await measure(
    "relationLoadStrategy: 'query'",
    runFixedQueryStrategy,
  );

  console.log('\nN+1 query counts');
  console.log(`N (orders)                    ${SAMPLE_SIZE}`);
  console.log(`naive (loop)                  ${naive}`);
  console.log(`leftJoinAndSelect             ${joined}`);
  console.log(`relationLoadStrategy: query   ${queryStrategy}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
