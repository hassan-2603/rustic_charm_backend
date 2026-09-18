import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function checkDetails() {
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const [tRows] = await pool.query("SELECT menu_item_id, language_code, name FROM menu_translations WHERE name LIKE '%shawarma%' OR name LIKE '%шаурма%'");
  console.log('Translations matching shawarma:', tRows);

  const [soupRows] = await pool.query("SELECT id, name FROM menu_items WHERE name LIKE '%triple%' OR name LIKE '%tripple%' OR name LIKE '%manchow%'");
  console.log('Items matching soup:', soupRows);

  const [muttonRows] = await pool.query("SELECT id, name, category_name FROM menu_items WHERE name LIKE '%mutton%'");
  console.log('Items matching mutton:', muttonRows);

  const [eggRiceRows] = await pool.query("SELECT id, name, category_name FROM menu_items WHERE name LIKE '%egg%'");
  console.log('Items matching egg:', eggRiceRows);

  await pool.end();
}
checkDetails().catch(console.error);
