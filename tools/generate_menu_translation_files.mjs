import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../database/rustic-charm.sqlite');
const sourceExcelPath = path.join(__dirname, '../../frontend/src/data/menu-translation.xlsx');
const tsPath = path.join(__dirname, '../../frontend/src/data/menuTranslations.ts');
const rootDir = path.join(__dirname, '../..');

// 1. Read curated Russian translations from menuTranslations.ts
const tsContent = fs.readFileSync(tsPath, 'utf8');
const tsTranslations = {};
for (const match of tsContent.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) {
  tsTranslations[match[1].trim()] = match[2].trim();
}

// 2. Bar and alcoholic drinks curated translations
const BAR_TRANSLATIONS = {
  // Beers
  'Breezer': 'Бризер',
  'Budweiser Magnum': 'Пиво Бадвайзер Магнум',
  'Budweiser Premium': 'Пиво Бадвайзер Премиум',
  'Carlsberg Elephant': 'Пиво Карлсберг Элефант',
  'Carlsberg Smooth': 'Пиво Карлсберг Смут',
  'Corona Extra': 'Пиво Корона Экстра',
  'Heineken': 'Пиво Хайнекен',
  'Hoegaarden': 'Пиво Хугарден',
  'Kingfisher Premium': 'Пиво Кингфишер Премиум',
  'Kingfisher Strong': 'Пиво Кингфишер Стронг',
  'Kingfisher Ultra': 'Пиво Кингфишер Ультра',
  'Tuborg Premium': 'Пиво Туборг Премиум',
  'Tuborg Strong': 'Пиво Туборг Стронг',

  // Cocktails
  'Aperol Spritz': 'Апероль Спритц',
  'Classic Martini': 'Классический Мартини',
  'Cuba Libre': 'Куба Либре',
  'Espresso Martini': 'Эспрессо Мартини',
  'Kokum Fizz': 'Кокум Физз',
  'Long Island Iced Tea': 'Лонг-Айленд Айс Ти',
  'Margarita': 'Маргарита',
  'Mojito': 'Мохито',
  'Pina Colada': 'Пина Колада',
  'Sex on the beach': 'Секс на пляже',
  'Tropical island': 'Тропический остров',
  'Urak': 'Урак (традиционный напиток Гоа)',

  // Spirits & Liquors
  'Absolut Blue': 'Водка Абсолют Блю',
  'Aperol': 'Апероль',
  'Bacardi Dark Rum': 'Темный ром Бакарди',
  'Bacardi White Rum': 'Белый ром Бакарди',
  'Ballantines': 'Виски Баллантайнс',
  'Black & White': 'Виски Блэк энд Уайт',
  'Black Dog': 'Виски Блэк Дог',
  'Blenders Pride': 'Виски Блендерс Прайд',
  'Blue Riband': 'Джин Блю Рибанд',
  'Bombay Sapphire': 'Джин Бомбей Сапфир',
  'Cabo (coconut rum)': 'Кокосовый ром Кабо',
  'Camino Real Blanco': 'Текила Камино Реал Бланко',
  'Coffee Liquor - Kahlua': 'Кофейный ликер Калуа',
  'Dewar & Sons (white label)': 'Виски Дюарс Уайт Лейбл',
  'Dom Henriques - Silver': 'Дон Энрикес Сильвер',
  'Glenfiddich': 'Виски Гленфиддик',
  'Greater Than': 'Джин Грейтер Зэн',
  'Honey Bee Brandy': 'Бренди Хани Би',
  'Jack Daniels': 'Виски Джек Дэниэлс',
  'Jagermeister': 'Ликер Егермейстер',
  'Jim Beam - Bourbon': 'Бурбон Джим Бим',
  'Johnnie Walker - Black Label': 'Виски Джонни Уокер Блэк Лейбл',
  'Johnnie Walker - Red Label': 'Виски Джонни Уокер Ред Лейбл',
  'Magic Moment': 'Водка Мэджик Момент',
  'Old Monk White Rum': 'Белый ром Олд Монк',
  'Old monk Dark Rum': 'Темный ром Олд Монк',
  'Romanov': 'Водка Романов',
  'Royal Challenge': 'Виски Роял Челлендж',
  'Royal Stag': 'Виски Роял Стэг',
  'Signature': 'Виски Сигнатура',
  'Smirnoff Red / Jamun': 'Водка Смирнофф Ред / Джамун',
  'Teacher’s Highland Cream': 'Виски Тичерс Хайленд Крим',
  'Tickle Dry': 'Джин Тикл Драй',
  'VAT 69': 'Виски ВАТ 69',

  // Wines
  'Big Banyan Red Wine': 'Красное вино Биг Баньян',
  'Big Banyan White Wine': 'Белое вино Биг Баньян',
  'Madera Red Wine': 'Красное вино Мадера',
  'Madera White Wine': 'Белое вино Мадера',
  'Nepolean Port No.7': 'Портвейн Наполеон №7',
  'Sula Red Wine': 'Красное вино Сула',
  'Sula White Wine': 'Белое вино Сула'
};

async function main() {
  const db = new sqlite3.Database(dbPath);
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { err ? rej(err) : res(this); }));

  // 3. Read source Excel file
  const wbSource = XLSX.readFile(sourceExcelPath);
  const sourceRows = XLSX.utils.sheet_to_json(wbSource.Sheets[wbSource.SheetNames[0]]);
  const excelMap = new Map();
  sourceRows.forEach(row => {
    const en = String(row['English'] || row['Menu Item'] || row['Item Name'] || '').trim();
    const ru = String(row['Recommended Option'] || row['Russian'] || row['Russian Name'] || '').trim();
    if (en && ru) {
      excelMap.set(en, ru);
    }
  });

  // 4. Fetch all menu items from database
  const dbRows = await all(`
    SELECT mi.id, mi.name as en_name, c.name as category, mt.name as db_ru
    FROM menu_items mi
    LEFT JOIN categories c ON mi.category_id = c.id
    LEFT JOIN menu_translations mt ON mi.id = mt.menu_item_id AND mt.language_code = 'ru'
  `);

  console.log(`Database rows: ${dbRows.length}`);

  // Helper to resolve the best, most authentic translation
  function resolveRussian(englishName, dbRu = '') {
    const trimmed = englishName.trim();
    // 1. High-priority curated fine-dining translations
    if (tsTranslations[trimmed]) {
      return tsTranslations[trimmed];
    }
    // 2. Curated bar translations
    if (BAR_TRANSLATIONS[trimmed]) {
      return BAR_TRANSLATIONS[trimmed];
    }
    // 3. Existing DB translation if not empty
    if (dbRu && dbRu.trim()) {
      return dbRu.trim();
    }
    // 4. Excel translation
    if (excelMap.has(trimmed)) {
      return excelMap.get(trimmed);
    }
    // 5. Case-insensitive / normalized Excel check
    for (const [k, v] of excelMap.entries()) {
      if (k.toLowerCase() === trimmed.toLowerCase()) {
        return v;
      }
    }
    return '';
  }

  // 5. Update SQLite menu_translations for all DB items with best translations
  let dbUpdates = 0;
  for (const item of dbRows) {
    const bestRu = resolveRussian(item.en_name, item.db_ru);
    if (bestRu && bestRu !== item.db_ru) {
      const transId = `trans-${item.id}-ru`;
      const now = new Date().toISOString();
      await run(`
        INSERT OR REPLACE INTO menu_translations (id, menu_item_id, language_code, name, description, created_at, updated_at)
        VALUES (?, ?, 'ru', ?, '', ?, ?)
      `, [transId, item.id, bestRu, now, now]);
      dbUpdates++;
    }
  }
  console.log(`Updated ${dbUpdates} translations in SQLite database with verified names.`);

  // 6. Build Master Item List
  const masterMap = new Map();

  // Distinct DB items
  dbRows.forEach(item => {
    const en = item.en_name.trim();
    if (!masterMap.has(en)) {
      const ru = resolveRussian(en, item.db_ru);
      masterMap.set(en, {
        english: en,
        russian: ru,
        category: item.category || '',
        inDb: true
      });
    }
  });

  // Items from source Excel
  sourceRows.forEach(row => {
    const en = String(row['English'] || row['Menu Item'] || row['Item Name'] || '').trim();
    if (!en) return;
    if (!masterMap.has(en)) {
      const ru = resolveRussian(en);
      masterMap.set(en, {
        english: en,
        russian: ru,
        category: '',
        inDb: false,
        inExcel: true
      });
    }
  });

  // Verify missing translations
  let missing = 0;
  for (const [en, data] of masterMap.entries()) {
    if (!data.russian || !data.russian.trim()) {
      console.warn(`Missing translation for: "${en}"`);
      missing++;
    }
  }
  console.log(`Total master items: ${masterMap.size}, Missing: ${missing}`);

  // Sort alphabetically by English name
  const sortedItems = [...masterMap.values()].sort((a, b) =>
    a.english.localeCompare(b.english, undefined, { sensitivity: 'base' })
  );

  const dbOnlyItems = sortedItems.filter(i => i.inDb);
  const foodBeverageItems = dbOnlyItems.filter(i => !BAR_TRANSLATIONS[i.english]);
  const barItems = dbOnlyItems.filter(i => BAR_TRANSLATIONS[i.english]);

  // 7. Write clean, 2-column master CSV
  function escapeCsv(val) {
    if (val === null || val === undefined) return '""';
    const s = String(val);
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  const csvHeader = 'English Name,Russian Name';
  const csvRows = sortedItems.map(i => `${escapeCsv(i.english)},${escapeCsv(i.russian)}`);
  const fullCsv = '\uFEFF' + [csvHeader, ...csvRows].join('\r\n');

  const outCsvPath = path.join(rootDir, 'menu_items_english_russian.csv');
  fs.writeFileSync(outCsvPath, fullCsv, 'utf8');
  console.log(`Wrote CSV to: ${outCsvPath} (${sortedItems.length} items)`);

  // Active DB only CSV
  const dbCsvRows = dbOnlyItems.map(i => `${escapeCsv(i.english)},${escapeCsv(i.russian)}`);
  const fullDbCsv = '\uFEFF' + [csvHeader, ...dbCsvRows].join('\r\n');
  const outDbCsvPath = path.join(rootDir, 'menu_items_active_database.csv');
  fs.writeFileSync(outDbCsvPath, fullDbCsv, 'utf8');
  console.log(`Wrote DB CSV to: ${outDbCsvPath} (${dbOnlyItems.length} items)`);

  // 8. Write multi-sheet and styled Excel workbook
  const wb = XLSX.utils.book_new();

  // Sheet 1: Master Menu Items (exact 2 columns: English Name, Russian Name)
  const sheet1Data = [
    ['English Name', 'Russian Name'],
    ...sortedItems.map(i => [i.english, i.russian])
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
  ws1['!cols'] = [{ wch: 45 }, { wch: 55 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'All Menu Items');

  // Sheet 2: Active Database Items (English Name, Russian Name, Category)
  const sheet2Data = [
    ['English Name', 'Russian Name', 'Category'],
    ...dbOnlyItems.map(i => [i.english, i.russian, i.category])
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);
  ws2['!cols'] = [{ wch: 45 }, { wch: 55 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Active Restaurant Menu (620)');

  // Sheet 3: Food & Regular Beverages
  const sheet3Data = [
    ['English Name', 'Russian Name', 'Category'],
    ...foodBeverageItems.map(i => [i.english, i.russian, i.category])
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(sheet3Data);
  ws3['!cols'] = [{ wch: 45 }, { wch: 55 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Food & Soft Drinks (554)');

  // Sheet 4: Bar & Alcoholic Beverages
  const sheet4Data = [
    ['English Name', 'Russian Name', 'Category'],
    ...barItems.map(i => [i.english, i.russian, i.category])
  ];
  const ws4 = XLSX.utils.aoa_to_sheet(sheet4Data);
  ws4['!cols'] = [{ wch: 45 }, { wch: 55 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, ws4, 'Bar & Spirits (66)');

  const outExcelPath = path.join(rootDir, 'menu_items_english_russian.xlsx');
  XLSX.writeFile(wb, outExcelPath);
  console.log(`Wrote Excel workbook to: ${outExcelPath}`);

  // Also update frontend Excel file
  const frontendExcelPath = path.join(rootDir, 'frontend', 'src', 'data', 'menu-translation.xlsx');
  XLSX.writeFile(wb, frontendExcelPath);
  console.log(`Updated frontend Excel workbook to: ${frontendExcelPath}`);

  db.close();
  console.log('Complete generation finished successfully!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
