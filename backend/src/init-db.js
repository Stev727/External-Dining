require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  await conn.query(sql);
  console.log('[init-db] done');
  await conn.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
