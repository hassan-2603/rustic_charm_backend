import dotenv from 'dotenv';
import { openDatabase } from '../config/database.js';
import { getMenuItems } from '../services/adminService.js';

dotenv.config({ path: './.env' });

async function run() {
  const db = openDatabase();
  await new Promise(r => setTimeout(r, 1000));

  console.log('--- Testing getMenuItems(db, "ru") ---');
  const itemsRu = await getMenuItems(db, "ru");
  console.log(`Loaded ${itemsRu.length} items for "ru".`);
  const sampleRu = itemsRu.slice(0, 5).map(i => ({ name: i.name, category: i.category, categoryLocalized: i.categoryLocalized }));
  console.log('Sample ru items:', sampleRu);

  console.log('\n--- Testing getMenuItems(db, "Russian") ---');
  const itemsRussian = await getMenuItems(db, "Russian");
  console.log(`Loaded ${itemsRussian.length} items for "Russian".`);
  const sampleRussian = itemsRussian.slice(0, 5).map(i => ({ name: i.name, category: i.category, categoryLocalized: i.categoryLocalized }));
  console.log('Sample Russian items:', sampleRussian);

  // Check how many have Cyrillic letters (indicating Russian translation)
  const cyrillicRegex = /[\u0400-\u04FF]/;
  const translatedRuCount = itemsRu.filter(i => cyrillicRegex.test(i.name)).length;
  console.log(`\nItems with Russian name (Cyrillic): ${translatedRuCount} / ${itemsRu.length}`);

  process.exit(0);
}

run().catch(console.error);
