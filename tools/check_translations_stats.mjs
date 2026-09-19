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

  const [totalItems] = await pool.query("SELECT COUNT(*) as count FROM menu_items");
  console.log(`Total menu_items: ${totalItems[0].count}`);

  const [transByLang] = await pool.query(`
    SELECT language_code, COUNT(*) as count 
    FROM menu_translations 
    GROUP BY language_code 
    ORDER BY count DESC
  `);
  console.log('\nTranslations in menu_translations table:');
  console.log(transByLang);

  // Check items that have NO translation at all
  const [noTrans] = await pool.query(`
    SELECT m.id, m.name 
    FROM menu_items m 
    LEFT JOIN menu_translations t ON m.id = t.menu_item_id 
    WHERE t.id IS NULL
    LIMIT 10
  `);
  console.log(`\nItems with NO translations at all (sample):`);
  console.log(noTrans);

  // Check Russian translations
  const [noRu] = await pool.query(`
    SELECT COUNT(*) as count 
    FROM menu_items m 
    LEFT JOIN menu_translations t ON m.id = t.menu_item_id AND t.language_code = 'ru'
    WHERE t.id IS NULL
  `);
  console.log(`\nItems missing Russian ('ru'): ${noRu[0].count}`);

  await pool.end();
}

run().catch(console.error);
