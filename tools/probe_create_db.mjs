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
  port: 19138,
  ssl: { rejectUnauthorized: false },
  connectTimeout: 10000,
};

async function run() {
  let conn;
  try {
    conn = await mysql.createConnection(config);

    // Check if rc_billing_test was created
    const [dbs] = await conn.query('SHOW DATABASES');
    console.log('All databases:', dbs.map(r => r.Database));

    const exists = dbs.some(r => r.Database === 'rc_billing_test');
    console.log('rc_billing_test exists:', exists);

    if (exists) {
      // Verify we can create tables and use InnoDB in the new schema
      try {
        await conn.query('USE rc_billing_test');
        await conn.query('CREATE TABLE IF NOT EXISTS _test_engine_check (id INT PRIMARY KEY) ENGINE=InnoDB');
        const [eng] = await conn.query(
          "SELECT ENGINE FROM information_schema.tables WHERE TABLE_SCHEMA='rc_billing_test' AND TABLE_NAME='_test_engine_check'"
        );
        console.log('InnoDB in rc_billing_test:', eng[0]?.ENGINE);
        await conn.query('DROP TABLE _test_engine_check');
        console.log('DROP TABLE succeeded');
      } catch (e) {
        console.log('InnoDB test in rc_billing_test FAILED:', e.message);
      }
    }
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    if (conn) await conn.end();
  }
}
run();
