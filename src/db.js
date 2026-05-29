const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

// SSL для production-хостов (Neon, Supabase, RDS и т.п.).
// Neon требует SSL обязательно; локальный postgres — без.
// rejectUnauthorized: false — потому что у Neon валидные публичные сертификаты,
// но узлы ротируются, и встроенный CA-bundle не всегда успевает.
const needsSsl =
  config.isProduction ||
  /\b(neon\.tech|render\.com|supabase\.co|rds\.amazonaws\.com|cockroachlabs\.cloud)\b/i.test(
    config.databaseUrl || ''
  );

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  // Разумные таймауты на free-планах (Neon может «просыпаться» 1-2 сек)
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

pool.on('error', (err) => {
  // Без этого один отвалившийся клиент в пуле = крах процесса
  console.error('[db] unexpected pool error:', err.message);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  await pool.query(sql);
}

// Проверка соединения для /api/health
async function dbPing() {
  try {
    const start = Date.now();
    const r = await pool.query('SELECT 1 AS ok');
    return { ok: r.rows[0]?.ok === 1, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  pool,
  query,
  initDb,
  dbPing
};
