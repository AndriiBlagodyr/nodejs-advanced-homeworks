import express from 'express';
import pg from 'pg';

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://app:app@localhost:5432/app';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const app = express();

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (rows[0].count === 0) {
    await pool.query(`INSERT INTO users (name) VALUES ('Alice'), ('Bob')`);
  }
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).type('text/plain').send('ok');
  } catch {
    res.status(503).type('text/plain').send('db unavailable');
  }
});

app.get('/users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name FROM users ORDER BY id ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /users failed:', err.message);
    res.status(500).json({ error: 'failed to load users' });
  }
});

await initDb();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on http://0.0.0.0:${PORT}`);
});
