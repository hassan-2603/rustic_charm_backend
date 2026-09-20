import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const config = {
  host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
  user: 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: 'defaultdb',
  port: 19138,
  ssl: { rejectUnauthorized: false },
  connectTimeout: 10000,
};

async function run() {
  let conn;
  try {
    conn = await mysql.createConnection(config);
    console.log('CONNECTED OK');

    const [dbs] = await conn.query('SHOW DATABASES');
    console.log('DATABASES:', dbs.map(r => r.Database));

    const [engines] = await conn.query(
      "SELECT ENGINE FROM information_schema.tables WHERE TABLE_SCHEMA = 'defaultdb' AND TABLE_NAME = 'orders'"
    );
    console.log('orders engine:', engines);

    const [orderCount] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM orders WHERE archived = 0 AND status NOT IN ('Completed','Cancelled','Rejected')"
    );
    console.log('Live (non-archived, non-terminal) orders:', orderCount[0].cnt);

    const [frozenCol] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE TABLE_SCHEMA='defaultdb' AND TABLE_NAME='orders' AND COLUMN_NAME='frozen_bill_json'"
    );
    console.log('frozen_bill_json column exists:', frozenCol[0].cnt > 0);

    const [privileges] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
    console.log('Grants:', privileges.map(r => Object.values(r)[0]));

  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    if (conn) await conn.end();
  }
}
run();
