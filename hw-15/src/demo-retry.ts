import { DataSource } from 'typeorm';
import { createDataSourceOptions } from './data-source';
import { withSerializationRetry } from './retry';

const ACCOUNT_ID = '9001';
const DELTA = 1;
const PARALLEL = 8;
const INITIAL_BALANCE = 100;

async function prepare(ds: DataSource): Promise<void> {
  await ds.query(
    `INSERT INTO users (id, email, full_name, balance_cents)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       full_name = EXCLUDED.full_name,
       balance_cents = EXCLUDED.balance_cents`,
    [ACCOUNT_ID, 'retry-demo@example.com', 'Retry Demo', INITIAL_BALANCE],
  );
}

/**
 * Read-modify-write under REPEATABLE READ. Concurrent runs collide → 40001.
 */
async function debitOnce(
  ds: DataSource,
  onRetry: (attempt: number, code: string) => void,
): Promise<void> {
  await withSerializationRetry(
    async () => {
      await ds.transaction('REPEATABLE READ', async (manager) => {
        const rows: Array<{ balance_cents: number }> = await manager.query(
          `SELECT balance_cents FROM users WHERE id = $1`,
          [ACCOUNT_ID],
        );
        const current = Number(rows[0].balance_cents);
        await new Promise((resolve) => setTimeout(resolve, 40));
        await manager.query(
          `UPDATE users SET balance_cents = $1 WHERE id = $2`,
          [current - DELTA, ACCOUNT_ID],
        );
      });
    },
    {
      maxAttempts: 20,
      baseDelayMs: 15,
      onRetry: ({ attempt, code }) => onRetry(attempt, code),
    },
  );
}

async function main(): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  await ds.initialize();

  try {
    await prepare(ds);
    console.log('demo:retry');
    console.log(`balance before: ${INITIAL_BALANCE}`);

    let retryEvents = 0;
    const codes = new Set<string>();

    await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        debitOnce(ds, (attempt, code) => {
          retryEvents += 1;
          codes.add(code);
          console.log(`retry #${attempt}: caught ${code}, re-running transaction`);
        }),
      ),
    );

    const afterRows: Array<{ balance_cents: number }> = await ds.query(
      `SELECT balance_cents FROM users WHERE id = $1`,
      [ACCOUNT_ID],
    );
    const after = Number(afterRows[0].balance_cents);
    const expected = INITIAL_BALANCE - PARALLEL * DELTA;

    console.log(`balance after: ${after}`);
    console.log(`expected: ${expected}`);
    console.log(`retry events: ${retryEvents}`);
    console.log(`retry codes: ${[...codes].join(',') || '(none)'}`);

    if (retryEvents < 1 || (![...codes].some((c) => c === '40001' || c === '40P01'))) {
      console.error('expected at least one 40001/40P01 retry');
      process.exit(1);
    }

    if (after !== expected) {
      console.error('final balance is arithmetically wrong');
      process.exit(1);
    }

    console.log('final state OK');
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
