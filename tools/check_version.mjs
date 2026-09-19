import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: './.env' });

async function run() {
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const [ver] = await pool.query("SELECT * FROM menu_versions");
  console.log('menu_versions table:', ver);

  const [dates] = await pool.query("SELECT MIN(created_at) as min_date, MAX(created_at) as max_date, COUNT(*) as c FROM menu_translations");
  console.log('menu_translations dates:', dates);

  await pool.end();
}

run().catch(console.error);
