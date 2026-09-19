import dotenv from 'dotenv';
import { openDatabase } from '../config/database.js';
import { getMenuItems } from '../services/adminService.js';

dotenv.config({ path: './.env' });

async function run() {
  const db = openDatabase();
  // Wait a moment for connection
  await new Promise(r => setTimeout(r, 1000));

  const items = await getMenuItems(db);
  console.log(`Loaded ${items.length} items from getMenuItems(db).`);

  const springRolls = items.find(it => it.name && it.name.toLowerCase().includes('spring rolls'));
  console.log('Spring Rolls item from getMenuItems():');
  console.log({
    id: springRolls?.id,
    name: springRolls?.name,
    description: springRolls?.description,
    translations: springRolls?.translations,
  });

  const vegRice = items.find(it => it.name && it.name.toLowerCase().includes('szechuan fried rice'));
  console.log('Szechuan rice item:');
  console.log({
    id: vegRice?.id,
    name: vegRice?.name,
    description: vegRice?.description,
    translations: vegRice?.translations,
  });

  // Check how many items have translations in getMenuItems result
  const itemsWithTranslations = items.filter(it => it.translations && Object.keys(it.translations).length > 0);
  console.log(`Items with translations populated: ${itemsWithTranslations.length} / ${items.length}`);

  process.exit(0);
}

run().catch(console.error);
