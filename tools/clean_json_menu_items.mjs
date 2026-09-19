import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: './.env' });

function extractEnglish(val) {
  if (!val) return "";
  if (typeof val === "object") {
    return String(val.English || val.en || val.english || Object.values(val)[0] || "").trim();
  }
  const str = String(val).trim();
  if (str.startsWith("{")) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "object" && parsed !== null) {
        return String(parsed.English || parsed.en || parsed.english || Object.values(parsed)[0] || "").trim();
      }
    } catch {}
  }
  return str;
}

async function run() {
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: { rejectUnauthorized: false }
  });

  const [rows] = await pool.query("SELECT id, name, description FROM menu_items WHERE name LIKE '{%' OR description LIKE '{%'");
  console.log(`Found ${rows.length} items needing cleanup in menu_items table.`);

  let updatedCount = 0;
  for (const row of rows) {
    const cleanName = extractEnglish(row.name);
    const cleanDesc = extractEnglish(row.description);

    if (cleanName !== row.name || cleanDesc !== row.description) {
      await pool.query(
        "UPDATE menu_items SET name = ?, description = ? WHERE id = ?",
        [cleanName, cleanDesc, row.id]
      );
      updatedCount++;
    }
  }

  console.log(`Successfully cleaned ${updatedCount} items in menu_items.`);

  // Verify
  const [remaining] = await pool.query("SELECT COUNT(*) as cnt FROM menu_items WHERE name LIKE '{%'");
  console.log(`Remaining items with JSON in name: ${remaining[0].cnt}`);

  const [springRolls] = await pool.query("SELECT id, name FROM menu_items WHERE name LIKE '%Spring Rolls%'");
  console.log('Spring Rolls row:', springRolls);

  await pool.end();
}

run().catch(console.error);
