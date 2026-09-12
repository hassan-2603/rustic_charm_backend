import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { openDatabase } from "../config/database.js";

import { translate } from "google-translate-api-x";

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
let currentModelIndex = 0;

const TARGET_LANGS = [
  { code: "ru", name: "Russian" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "kk", name: "Kazakh" },
  { code: "he", name: "Hebrew" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("==================================================");
  console.log("  🚀 RUSTIC CHARM HIGH-SPEED MENU TRANSLATION");
  console.log("  Models: " + CANDIDATE_MODELS.join(", "));
  console.log("==================================================");

  const db = openDatabase();

  console.log("\n[1/4] Fetching menu items from database...");
  const menuItems = await db.all(
    "SELECT id, name, description FROM menu_items ORDER BY created_at ASC"
  );
  console.log(`Found ${menuItems.length} total menu items in database.`);

  console.log("\n[2/4] Fetching existing translations...");
  const existingRows = await db.all(
    "SELECT menu_item_id, language_code, name, description FROM menu_translations"
  );
  const existingMap = {};
  for (const row of existingRows) {
    if (!existingMap[row.menu_item_id]) {
      existingMap[row.menu_item_id] = {};
    }
    existingMap[row.menu_item_id][row.language_code] = {
      name: row.name,
      description: row.description,
    };
  }
  console.log(`Loaded ${existingRows.length} existing translation entries.`);

  // Filter items that need translation
  const itemsToTranslate = [];
  for (const item of menuItems) {
    const enName = extractEnglish(item.name);
    const enDesc = extractEnglish(item.description);
    if (!enName) continue;

    const itemTrans = existingMap[item.id] || {};
    const missingLangs = TARGET_LANGS.filter((l) => {
      const existing = itemTrans[l.code];
      return !existing || !existing.name || existing.name.trim() === "";
    });

    if (missingLangs.length > 0) {
      itemsToTranslate.push({
        id: item.id,
        rawName: item.name,
        rawDesc: item.description,
        enName,
        enDesc,
        hasDesc: enDesc.length > 0,
        missingLangs,
      });
    }
  }

  // Ensure any JSON-encoded names in menu_items are restored to clean English
  for (const item of menuItems) {
    if (typeof item.name === 'string' && item.name.trim().startsWith('{')) {
      const enName = extractEnglish(item.name);
      const enDesc = extractEnglish(item.description);
      await db.run("UPDATE menu_items SET name = ?, description = ? WHERE id = ?", [enName, enDesc, item.id]);
    }
  }

  console.log(`\nItems needing translation: ${itemsToTranslate.length} of ${menuItems.length}`);
  if (itemsToTranslate.length === 0) {
    console.log("✅ All menu items are already fully translated into all 7 languages!");
    process.exit(0);
  }

  console.log("\n[3/4] Translating items in batches via Gemini AI...");
  const BATCH_SIZE = 25;
  let totalTranslated = 0;
  let totalTranslationsSaved = 0;

  for (let b = 0; b < itemsToTranslate.length; b += BATCH_SIZE) {
    const batch = itemsToTranslate.slice(b, b + BATCH_SIZE);
    const batchNum = Math.floor(b / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(itemsToTranslate.length / BATCH_SIZE);

    console.log(
      `\n--- Batch ${batchNum}/${totalBatches} (Items ${b + 1} to ${Math.min(b + BATCH_SIZE, itemsToTranslate.length)}) ---`
    );

    const promptItems = batch.map((item, idx) => ({
      index: idx + 1,
      id: item.id,
      dish_name: item.enName,
      dish_description: item.hasDesc ? item.enDesc : "",
      languages_needed: item.missingLangs.map((l) => `${l.name} (${l.code})`),
    }));

    const prompt = `You are a culinary expert and translator for "Rustic Charm", a premium luxury restaurant.
Translate the following dish names and optional descriptions into the specified languages.

CRITICAL RULES:
1. Use authentic, high-end gastronomic / culinary terminology for each language (Russian, German, Spanish, Kazakh, Hebrew, Japanese, Korean).
2. If dish_description is empty "", keep the translated description as "".
3. Return ONLY a valid, parseable JSON array of objects without Markdown formatting or explanations.

Required JSON Structure:
[
  {
    "id": "<item_id>",
    "translations": {
      "ru": { "name": "...", "description": "..." },
      "de": { "name": "...", "description": "..." }
    }
  }
]

Items to translate:
${JSON.stringify(promptItems, null, 2)}`;

    let responseData = null;
    let retries = 4;
    while (retries > 0) {
      const activeModel = CANDIDATE_MODELS[currentModelIndex];
      try {
        const result = await ai.models.generateContent({
          model: activeModel,
          contents: prompt,
        });

        let rawText = result.text?.trim() || "";
        rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
        responseData = JSON.parse(rawText);
        break;
      } catch (err) {
        retries--;
        const isQuotaOrDemand = err.message.includes("429") || err.message.includes("503") || err.message.includes("UNAVAILABLE") || err.message.includes("RESOURCE_EXHAUSTED") || err.message.includes("quota");
        if (isQuotaOrDemand && currentModelIndex < CANDIDATE_MODELS.length - 1) {
          currentModelIndex++;
          console.warn(`⏳ Issue on ${activeModel}. Immediately switching to: ${CANDIDATE_MODELS[currentModelIndex]}...`);
          await sleep(500);
          continue;
        } else if (isQuotaOrDemand) {
          console.warn(`⏳ All Gemini models busy/limited. Falling back to Google Translate...`);
          break;
        } else {
          console.warn(`⚠️ Batch ${batchNum} error: ${err.message}. Retrying in 2s... (${retries} left)`);
          await sleep(2000);
        }
      }
    }

    if (!responseData || !Array.isArray(responseData)) {
      console.log(`🌐 Translating batch ${batchNum} with high-speed Google Translate fallback...`);
      responseData = [];
      for (const item of batch) {
        const itemTrans = {};
        for (const lang of item.missingLangs) {
          try {
            const resName = await translate(item.enName, { to: lang.code === "he" ? "iw" : lang.code });
            let resDescText = "";
            if (item.hasDesc) {
              const resDesc = await translate(item.enDesc, { to: lang.code === "he" ? "iw" : lang.code });
              resDescText = resDesc.text || "";
            }
            itemTrans[lang.code] = { name: resName.text || item.enName, description: resDescText };
          } catch {
            itemTrans[lang.code] = { name: item.enName, description: item.hasDesc ? item.enDesc : "" };
          }
        }
        responseData.push({ id: item.id, translations: itemTrans });
      }
    }

    // Map responses by ID
    const resultMap = new Map();
    for (const resItem of responseData) {
      if (resItem?.id) {
        resultMap.set(resItem.id, resItem.translations || {});
      }
    }

    // Persist batch into MySQL database
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");

    for (const item of batch) {
      const transObj = resultMap.get(item.id) || {};
      const existingNames = parseJsonSafe(item.rawName);
      const existingDescs = parseJsonSafe(item.rawDesc);

      const updatedNames = {
        ...existingNames,
        English: item.enName,
      };
      const updatedDescs = {
        ...existingDescs,
        English: item.enDesc,
      };

      let savedForThisItem = 0;

      for (const lang of item.missingLangs) {
        const t = transObj[lang.code] || transObj[lang.name] || {};
        const tName = (t.name || "").trim();
        const tDesc = item.hasDesc ? (t.description || "").trim() : "";

        if (tName) {
          // Upsert into menu_translations
          const existingTrans = await db.get(
            "SELECT id FROM menu_translations WHERE menu_item_id = ? AND language_code = ? LIMIT 1",
            [item.id, lang.code]
          );

          if (existingTrans) {
            await db.run(
              "UPDATE menu_translations SET name = ?, description = ?, updated_at = ? WHERE menu_item_id = ? AND language_code = ?",
              [tName, tDesc, now, item.id, lang.code]
            );
          } else {
            const newId = crypto.randomUUID();
            await db.run(
              "INSERT INTO menu_translations (id, menu_item_id, language_code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [newId, item.id, lang.code, tName, tDesc, now, now]
            );
          }

          updatedNames[lang.name] = tName;
          updatedDescs[lang.name] = tDesc;
          savedForThisItem++;
          totalTranslationsSaved++;
        }
      }

      // Keep menu_items clean with plain English name and description (translations live in menu_translations)
      await db.run(
        "UPDATE menu_items SET name = ?, description = ?, updated_at = ? WHERE id = ?",
        [item.enName, item.hasDesc ? item.enDesc : "", now, item.id]
      );

      totalTranslated++;
      console.log(`  ✓ [${totalTranslated}/${itemsToTranslate.length}] "${item.enName}" -> ${savedForThisItem} languages saved.`);
    }

    // 3.5-second pacing to stay comfortably under the 20 requests/minute free tier ceiling
    await sleep(3500);
  }

  console.log("\n[4/4] Updating menu version timestamp...");
  try {
    const versionRow = await db.get("SELECT version_number FROM menu_versions WHERE id = 'latest'");
    const nextVer = (versionRow?.version_number || 1) + 1;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.run(
      "INSERT INTO menu_versions (id, version_number, created_at) VALUES ('latest', ?, ?) ON DUPLICATE KEY UPDATE version_number = ?, created_at = ?",
      [nextVer, now, nextVer, now]
    );
    console.log(`Menu version updated to #${nextVer}.`);
  } catch (err) {
    console.warn("Could not update menu_versions table:", err.message);
  }

  console.log("\n==================================================");
  console.log("  🎉 TRANSLATION COMPLETED SUCCESSFULLY!");
  console.log(`  • Items processed: ${totalTranslated}`);
  console.log(`  • Translations inserted/updated: ${totalTranslationsSaved}`);
  console.log("==================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal translation error:", err);
  process.exit(1);
});
