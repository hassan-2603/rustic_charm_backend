import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function search() {
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const keywords = ['crispy', 'hakka', 'schezwan', 'shawarma', 'hummus', 'pita', 'garlic', 'tom yum', 'tripple', 'triple', 'thali', 'noodles', 'curry'];
  const [items] = await pool.query('SELECT id, name, category_name FROM menu_items');

  for (const kw of keywords) {
    const matched = items.filter(it => it.name.toLowerCase().includes(kw));
    console.log(`Keyword [${kw}] (${matched.length} items):`);
    for (const m of matched.slice(0, 10)) {
      console.log(`  - [${m.id}] ${m.name} (${m.category_name})`);
    }
  }
  await pool.end();
}
search().catch(console.error);
