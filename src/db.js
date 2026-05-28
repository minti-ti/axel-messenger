const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = {
  pool,
  query,
  initDb
};
