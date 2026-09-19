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

  const [rows] = await pool.query("SELECT id, name, category_id, category_name FROM menu_items WHERE name LIKE '%Spring Rolls%' OR name LIKE '%szechuan%' LIMIT 5");
  console.log('Items category info:', rows);

  await pool.end();
}

run().catch(console.error);
