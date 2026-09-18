import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function searchPrawnsAndChicken() {
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const [items] = await pool.query('SELECT id, name, category_name FROM menu_items');

  console.log('--- ALL PRAWN DISHES ---');
  items.filter(it => it.name.toLowerCase().includes('prawn')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  console.log('\n--- ALL CHICKEN DISHES WITH CRISPY, SHAWARMA, THALI, FRIED RICE ---');
  items.filter(it => it.name.toLowerCase().includes('shawarma') || it.name.toLowerCase().includes('thali') || it.name.toLowerCase().includes('fried rice')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  await pool.end();
}
searchPrawnsAndChicken().catch(console.error);
