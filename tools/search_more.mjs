import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function searchMore() {
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const [items] = await pool.query('SELECT id, name, category_name FROM menu_items');

  console.log('--- ALL EGG DISHES ---');
  items.filter(it => it.name.toLowerCase().includes('egg')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  console.log('\n--- ALL RICE DISHES ---');
  items.filter(it => it.name.toLowerCase().includes('rice')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  console.log('\n--- ALL SHAWARMA / ROLL DISHES ---');
  items.filter(it => it.name.toLowerCase().includes('roll') || it.name.toLowerCase().includes('shawarma') || it.name.toLowerCase().includes('wrap')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  console.log('\n--- ALL THALI DISHES ---');
  items.filter(it => it.name.toLowerCase().includes('thali')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  console.log('\n--- ALL NOODLES DISHES ---');
  items.filter(it => it.name.toLowerCase().includes('noodle')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  console.log('\n--- ALL TRIPLE / TRIPPLE SOUP DISHES ---');
  items.filter(it => it.name.toLowerCase().includes('soup')).forEach(it => {
    console.log(`[${it.id}] ${it.name} (${it.category_name})`);
  });

  await pool.end();
}
searchMore().catch(console.error);
