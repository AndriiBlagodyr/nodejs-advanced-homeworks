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

async function waitForDb({ retries = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await initDb();
      console.log('Database is ready');
      return;
    } catch (err) {
      console.error(
        `DB connect/init attempt ${attempt}/${retries} failed: ${err.message}`
      );
      if (attempt === retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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

try {
  await waitForDb();
} catch (err) {
  console.error('Could not initialize database:', err.message);
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on http://0.0.0.0:${PORT}`);
});
