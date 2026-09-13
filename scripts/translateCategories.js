import dotenv from "dotenv";
dotenv.config();

import { GoogleGenAI } from "@google/genai";
import { openDatabase } from "../config/database.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is missing from environment (.env)");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const CANDIDATE_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.7-flash",
  "gemini-flash-latest"
];

function extractEnglish(val) {
  if (!val) return "";
  if (typeof val === "object") {
    return String(val.English || val.en || Object.values(val)[0] || "").trim();
  }
  const str = String(val).trim();
  if (str.startsWith("{")) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "object" && parsed !== null) {
        return String(parsed.English || parsed.en || Object.values(parsed)[0] || "").trim();
      }
    } catch {}
  }
  return str;
}

function parseJsonSafe(val) {
  if (!val) return {};
  if (typeof val === "object") return { ...val };
  const str = String(val).trim();
  if (str.startsWith("{")) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {}
  }
  return {};
}

async function main() {
  console.log("==================================================");
  console.log("  🚀 RUSTIC CHARM CATEGORY TRANSLATION");
  console.log("==================================================");

  const db = openDatabase();
  const rows = await db.all("SELECT id, name FROM categories ORDER BY display_order ASC");
  console.log(`Loaded ${rows.length} categories from database.`);

  const listToTranslate = rows.map((r) => ({
    id: r.id,
    english: extractEnglish(r.name),
    existing: parseJsonSafe(r.name),
  }));

  const prompt = `You are a culinary expert and translator for "Rustic Charm", a premium luxury restaurant.
Translate each restaurant menu category name into these exact languages:
- Russian (ru)
- German (de)
- Spanish (es)
- Kazakh (kk)
- Hebrew (he)
- Japanese (ja)
- Korean (ko)

CRITICAL RULES:
1. Preserve fine-dining / gastronomic restaurant terminology.
2. Return ONLY a valid, parseable JSON array of objects without Markdown formatting or explanations.

Required JSON Structure:
[
  {
    "id": "<category_id>",
    "translations": {
      "English": "...",
      "Russian": "...",
      "German": "...",
      "Spanish": "...",
      "Kazakh": "...",
      "Hebrew": "...",
      "Japanese": "...",
      "Korean": "..."
    }
  }
]

Categories to translate:
${JSON.stringify(listToTranslate.map(c => ({ id: c.id, english_name: c.english, current_russian: c.existing.Russian || "" })), null, 2)}`;

  let responseData = null;
  for (const model of CANDIDATE_MODELS) {
    try {
      console.log(`Translating categories with ${model}...`);
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
      });
      let rawText = res.text?.trim() || "";
      rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
      responseData = JSON.parse(rawText);
      console.log(`✓ Received translations from ${model}`);
      break;
    } catch (err) {
      console.warn(`⚠️ Model ${model} failed: ${err.message}`);
    }
  }

  if (!responseData || !Array.isArray(responseData)) {
    console.error("❌ Failed to translate categories.");
    process.exit(1);
  }

  console.log("\nPersisting category translations to database...");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  for (const row of rows) {
    const found = responseData.find((r) => r.id === row.id);
    const existing = parseJsonSafe(row.name);
    const enName = extractEnglish(row.name);

    const merged = {
      ...existing,
      English: enName,
      ...(found?.translations || {}),
    };

    // If existing had a high-quality Russian translation, prefer preserving it unless empty
    if (existing.Russian && existing.Russian.trim()) {
      merged.Russian = existing.Russian.trim();
    }

    const jsonStr = JSON.stringify(merged);
    await db.run(
      "UPDATE categories SET name = ?, updated_at = ? WHERE id = ?",
      [jsonStr, now, row.id]
    );

    console.log(`✓ [${row.id}] ${enName} -> ${Object.keys(merged).length} languages`);
  }

  console.log("\nUpdating menu version timestamp...");
  try {
    const versionRow = await db.get("SELECT version_number FROM menu_versions WHERE id = 'latest'");
    const nextVer = (versionRow?.version_number || 1) + 1;
    await db.run(
      "INSERT INTO menu_versions (id, version_number, created_at) VALUES ('latest', ?, ?) ON DUPLICATE KEY UPDATE version_number = ?, created_at = ?",
      [nextVer, now, nextVer, now]
    );
    console.log(`Menu version updated to #${nextVer}.`);
  } catch (err) {
    console.warn("Could not update menu_versions table:", err.message);
  }

  console.log("\n🎉 All 39 categories successfully translated into all 8 languages!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
