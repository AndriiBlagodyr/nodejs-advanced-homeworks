import { Client } from 'pg';

export async function ensureProcessedEventsTable(db: Client): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function truncateProcessedEvents(db: Client): Promise<void> {
  await db.query('TRUNCATE TABLE processed_events');
}

/** Idempotent effect: natural key event_id, survives process restart. */
export async function applyOrderPlacedEffect(
  db: Client,
  eventId: string,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO processed_events (event_id)
     VALUES ($1)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId],
  );
  return (res.rowCount ?? 0) === 1;
}

export async function countEffects(db: Client): Promise<number> {
  const res = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM processed_events');
  return Number(res.rows[0].n);
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DB_URL;
  if (!url) {
    throw new Error('DATABASE_URL: unbound variable');
  }
  return url;
}
