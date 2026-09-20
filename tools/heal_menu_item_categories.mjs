import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function run() {
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const [cats] = await pool.query('SELECT id, name FROM categories');
  const catMap = new Map();
  for (const c of cats) {
    catMap.set(c.id.toLowerCase(), c.id);
    try {
      const p = JSON.parse(c.name);
      for (const v of Object.values(p)) {
        if (typeof v === 'string') catMap.set(v.toLowerCase().trim(), c.id);
      }
    } catch {
      catMap.set(c.name.toLowerCase().trim(), c.id);
    }
    const slug = c.id.replace(/^cat-/, '').replace(/[-_/]+/g, ' ').trim().toLowerCase();
    catMap.set(slug, c.id);
  }
  catMap.set('chinese favorites', 'cat-asian-favorites');
  catMap.set('chinese  favorites', 'cat-asian-favorites');
  catMap.set('tibet kitchen', "cat-chef's-recommendation");
  catMap.set('rice & bowls', 'cat-rice-&-bowls');
  catMap.set('something sweet', 'cat-something-sweet');
  catMap.set('extra cheese', 'cat-fries-&-sides');
  catMap.set('bourekas-', '88cb9781-d671-4327-8063-bb0e2adaa127');

  const [items] = await pool.query('SELECT id, name, category_name FROM menu_items WHERE category_id IS NULL');
  console.log(`Found ${items.length} items with category_id IS NULL`);

  let updatedCount = 0;
  for (const it of items) {
    let cName = (it.category_name || '').trim().toLowerCase();
    if (!cName && it.name.toLowerCase().includes('cheese')) {
      cName = 'extra cheese';
    } else if (!cName && it.name.toLowerCase().includes('bourekas')) {
      cName = 'bourekas-';
    }
    const matchedCatId = catMap.get(cName);
    if (matchedCatId) {
      await pool.query('UPDATE menu_items SET category_id = ? WHERE id = ?', [matchedCatId, it.id]);
      updatedCount++;
    } else {
      console.warn(`Could not map item: id=${it.id}, name="${it.name}", category_name="${it.category_name}"`);
    }
  }

  console.log(`Successfully updated ${updatedCount} items in menu_items.`);

  const [remaining] = await pool.query('SELECT count(*) as cnt FROM menu_items WHERE category_id IS NULL');
  console.log(`Remaining items with category_id IS NULL: ${remaining[0].cnt}`);

  await pool.end();
}

run().catch(console.error);
