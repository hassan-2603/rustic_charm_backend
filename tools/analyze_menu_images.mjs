import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = mysql.createPool({
  host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
  user: 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: 'defaultdb',
  port: 19138,
  ssl: { rejectUnauthorized: false }
});

function cleanName(name) {
  if (!name) return '';
  // First strip extension
  let cleaned = name.replace(/\.[a-zA-Z0-9]+$/, '');
  // Remove content inside parenthesis, brackets, curly braces
  cleaned = cleaned.replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{[^}]*\}/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[-_,.'"/\\#!$%^&*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

function normalizeWord(w) {
  if (w === 'yoghurt' || w === 'yogurt' || w === 'curds') return 'curd';
  if (w === 'vegetable' || w === 'vegetables') return 'veg';
  if (w === 'mixed') return 'mix';
  if (w === 'miv') return 'mix';
  if (w === 'lacha' || w === 'lachha') return 'laccha';
  if (w === 'maggie') return 'maggi';
  if (w === 'custurd') return 'custard';
  if (w === 'musli') return 'muesli';
  if (w === 'tequilla') return 'tequila';
  if (w === 'tirramissu') return 'tiramisu';
  if (w === 'lolypop') return 'lollipop';
  if (w === 'chilly' || w === 'chilli') return 'chili';
  if (w === 'englis') return 'english';
  if (w === 'dall') return 'dal';
  if (w === 'garkic') return 'garlic';
  if (w === 'tripple') return 'triple';
  if (w === 'schezwan' || w === 'szechuan' || w === 'shezwan') return 'schezwan';
  if (w === 'shwarma' || w === 'shawarma') return 'shawarma';
  if (w === 'prawn' || w === 'prawns') return 'prawn';
  if (w === 'noodle' || w === 'noodles') return 'noodle';
  if (w === 'soup' || w === 'soups') return 'soup';
  if (w === 'hummus' || w === 'humus') return 'hummus';
  if (w.length > 3 && w.endsWith('s') && !['hummus', 'curry'].includes(w)) {
    if (w === 'fries') return 'fry';
    return w.slice(0, -1);
  }
  return w;
}

function getNormalizedKey(name) {
  const cleaned = cleanName(name);
  if (!cleaned) return '';
  const words = cleaned.split(' ').map(normalizeWord).filter(w => !['image', 'img', 'photo', 'food', 'final', 'new', 'latest', 'copy', 'the'].includes(w));
  words.sort();
  return words.join(' ');
}

function calculateConfidence(normImage, normItem, rawImage, rawItem) {
  if (normImage === normItem) return 1.0;

  const t1 = normImage.split(' ').filter(Boolean);
  const t2 = normItem.split(' ').filter(Boolean);

  const set1 = new Set(t1);
  const set2 = new Set(t2);

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  const jaccard = intersection.size / union.size;

  // If one set completely contains the other
  const subsetRatio = intersection.size / Math.min(set1.size, set2.size);
  if (subsetRatio === 1.0) {
    // Penalize if large difference in length (e.g. "Chicken" vs "Chicken Biryani Fried Rice")
    const lengthDiff = Math.abs(set1.size - set2.size);
    if (lengthDiff <= 1) return 0.90;
    if (lengthDiff <= 2) return 0.75;
    return 0.50;
  }

  return jaccard;
}

async function run() {
  const [items] = await pool.query('SELECT id, name, category_id, image_url, is_veg FROM menu_items');
  console.log(`\n=== Loaded ${items.length} menu items from Aiven MySQL ===`);

  // Inspect imagee folder
  const imageeDir = path.resolve(__dirname, '../../imagee/rustic charm');
  const files = fs.readdirSync(imageeDir);
  console.log(`Found ${files.length} image files in imagee/rustic charm`);

  // Group files by normalized key
  const groups = new Map();
  for (const f of files) {
    const norm = getNormalizedKey(f);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(f);
  }

  console.log(`Resolved into ${groups.size} unique food image subjects\n`);

  const highMatches = [];
  const mediumMatches = [];
  const lowMatches = [];

  for (const [normKey, origFiles] of groups.entries()) {
    let matches = [];

    for (const item of items) {
      const itemNorm = getNormalizedKey(item.name);
      const conf = calculateConfidence(normKey, itemNorm, origFiles[0], item.name);

      if (conf >= 0.5) {
        matches.push({
          item,
          conf,
          itemNorm
        });
      }
    }

    matches.sort((a, b) => b.conf - a.conf);

    if (matches.length > 0 && matches[0].conf >= 0.85) {
      const top = matches[0];
      const conflict = matches.length > 1 && matches[1].conf >= 0.8;
      highMatches.push({
        normKey,
        files: origFiles,
        matchedItem: top.item,
        confidence: top.conf,
        conflict: conflict ? matches.slice(1, 3) : null
      });
    } else if (matches.length > 0 && matches[0].conf >= 0.60) {
      mediumMatches.push({
        normKey,
        files: origFiles,
        candidates: matches.slice(0, 3)
      });
    } else {
      lowMatches.push({
        normKey,
        files: origFiles,
        topCandidate: matches[0] || null
      });
    }
  }

  console.log(`\n-----------------------------------------------------`);
  console.log(`1. HIGH CONFIDENCE MATCHES (>= 85%): ${highMatches.length}`);
  console.log(`-----------------------------------------------------`);
  for (const m of highMatches) {
    console.log(`✅ [${(m.confidence * 100).toFixed(0)}%] Subject: "${m.normKey}"`);
    console.log(`   Files: ${m.files.join(', ')}`);
    console.log(`   -> Menu Item: "${m.matchedItem.name}" (ID: ${m.matchedItem.id}, Current Image: "${m.matchedItem.image_url}")`);
    if (m.conflict) {
      console.log(`   ⚠️ CONFLICT WARNING: Also resembles: ${m.conflict.map(c => `"${c.item.name}" (${(c.conf*100).toFixed(0)}%)`).join(', ')}`);
    }
  }

  console.log(`\n-----------------------------------------------------`);
  console.log(`2. MEDIUM CONFIDENCE MATCHES (60% - 84%): ${mediumMatches.length}`);
  console.log(`-----------------------------------------------------`);
  for (const m of mediumMatches) {
    console.log(`⚠️ Subject: "${m.normKey}" (Files: ${m.files.join(', ')})`);
    console.log(`   Candidates: ${m.candidates.map(c => `"${c.item.name}" (${(c.conf * 100).toFixed(0)}%)`).join(' | ')}`);
  }

  console.log(`\n-----------------------------------------------------`);
  console.log(`3. LOW / UNMATCHED (< 60%): ${lowMatches.length}`);
  console.log(`-----------------------------------------------------`);
  for (const m of lowMatches) {
    console.log(`❌ Subject: "${m.normKey}" (Files: ${m.files.join(', ')})`);
    if (m.topCandidate) {
      console.log(`   Weakest lead: "${m.topCandidate.item.name}" (${(m.topCandidate.conf * 100).toFixed(0)}%)`);
    }
  }

  await pool.end();
}

run().catch(console.error);
