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

// По умолчанию у managed-Postgres (Neon/Supabase/RDS) валидные публичные
// сертификаты. С версии Node 20+ встроенный CA-bundle (Mozilla) их валидирует
// нормально, поэтому строгую проверку держим включённой по умолчанию —
// иначе остаётся теоретический MITM между приложением и БД.
//
// Если ваш провайдер использует свой CA (например, on-prem Postgres,
// self-signed сертификат), задайте DB_SSL_CA = PEM-строка с CA-сертификатом.
// Только в крайнем случае (диагностика, миграция) можно явно ослабить:
// DB_SSL_STRICT=false.
const sslStrict = String(process.env.DB_SSL_STRICT || 'true') !== 'false';
const sslConfig = needsSsl
  ? {
      rejectUnauthorized: sslStrict,
      ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') } : {})
    }
  : false;

if (config.isProduction && needsSsl && !sslStrict) {
  console.warn(
    '[db] WARNING: DB_SSL_STRICT=false in production — connection is vulnerable to MITM. ' +
    'Remove DB_SSL_STRICT or set it to true.'
  );
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: sslConfig,
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
