import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const zomatoDir = path.join(__dirname, '../../rustic charmzomato/rustic charm');

async function analyze() {
  if (!fs.existsSync(zomatoDir)) {
    console.error('Zomato dir not found:', zomatoDir);
    return;
  }

  const files = fs.readdirSync(zomatoDir);
  console.log(`Found ${files.length} total files in zomato directory.`);

  // Group by clean base name
  const photoGroups = new Map();
  for (const file of files) {
    if (!file.match(/\.(jpg|jpeg|png|webp)$/i)) continue;
    // Clean name: remove (1), (2), etc. and extension
    const base = path.basename(file, path.extname(file))
      .replace(/\(\d+\)/g, '')
      .replace(/[-_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (!photoGroups.has(base)) {
      photoGroups.set(base, []);
    }
    photoGroups.get(base).push(file);
  }

  console.log(`Identified ${photoGroups.size} unique dish photo concepts:`);
  for (const [concept, list] of photoGroups.entries()) {
    console.log(`  - "${concept}": [${list.join(', ')}]`);
  }

  // Connect to MySQL
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const [items] = await pool.query('SELECT id, name, category_name, category_id, image_url, price FROM menu_items');
  console.log(`\nRetrieved ${items.length} menu items from database.`);

  // Try matching
  const matched = [];
  const unmatched = [];

  for (const [concept, fileList] of photoGroups.entries()) {
    // Look for matches in DB
    const candidates = items.filter(it => {
      let itName = it.name;
      try {
        const parsed = JSON.parse(it.name);
        itName = parsed.English || parsed.en || Object.values(parsed)[0] || it.name;
      } catch (e) {}

      const cleanDbName = String(itName || '')
        .toLowerCase()
        .replace(/[-_]/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const cleanConcept = concept.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

      return cleanDbName === cleanConcept ||
             cleanDbName.includes(cleanConcept) ||
             cleanConcept.includes(cleanDbName);
    });

    if (candidates.length > 0) {
      matched.push({ concept, fileList, candidates });
    } else {
      unmatched.push({ concept, fileList });
    }
  }

  console.log(`\n=== MATCHING SUMMARY ===`);
  console.log(`Matched Concepts: ${matched.length} / ${photoGroups.size}`);
  console.log(`Unmatched Concepts: ${unmatched.length} / ${photoGroups.size}`);

  console.log(`\n--- MATCHED DETAILS ---`);
  for (const m of matched) {
    console.log(`Concept: "${m.concept}" (${m.fileList.length} files: ${m.fileList.join(', ')})`);
    for (const c of m.candidates) {
      let displayName = c.name;
      try {
        const p = JSON.parse(c.name);
        displayName = p.English || p.en || c.name;
      } catch (e) {}
      console.log(`    -> DB Item [${c.id}]: "${displayName}" | Cat: ${c.category_name} | Current Image: "${c.image_url}"`);
    }
  }

  if (unmatched.length > 0) {
    console.log(`\n--- UNMATCHED DETAILS ---`);
    for (const u of unmatched) {
      console.log(`Concept: "${u.concept}" -> files: [${u.fileList.join(', ')}]`);
    }
  }

  await pool.end();
}

analyze().catch(console.error);
