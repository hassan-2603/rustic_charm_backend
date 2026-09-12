import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translate } from "google-translate-api-x";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SUPPORTED_LANGUAGES = [
  { name: "Russian", code: "ru" },
  { name: "German", code: "de" },
  { name: "Spanish", code: "es" },
  { name: "Kazakh", code: "kk" },
  { name: "Hebrew", code: "he" },
  { name: "Japanese", code: "ja" },
  { name: "Korean", code: "ko" },
];

const LANG_MAP = new Map();
for (const lang of SUPPORTED_LANGUAGES) {
  LANG_MAP.set(lang.name.toLowerCase(), lang);
  LANG_MAP.set(lang.code.toLowerCase(), lang);
}

// Load authentic Russian fine-dining translations from local dictionary if available
let russianDictionary = {};
try {
  const dictPath = path.resolve(__dirname, "../../frontend/src/data/menuTranslations.ts");
  if (fs.existsSync(dictPath)) {
    const content = fs.readFileSync(dictPath, "utf8");
    const match = content.match(/export const RUSSIAN_TRANSLATIONS[^{]*\{([\s\S]*?)\n\};/);
    if (match) {
      const lines = match[1].split("\n");
      for (const line of lines) {
        const lineMatch = line.match(/"([^"]+)":\s*"([^"]+)"/);
        if (lineMatch) {
          russianDictionary[lineMatch[1].trim().toLowerCase()] = lineMatch[2].trim();
        }
      }
    }
  }
} catch (e) {
  console.warn("Could not load local Russian fine-dining dictionary:", e.message);
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    return new GoogleGenAI({ apiKey });
  } catch {
    return null;
  }
}

/**
 * Translates items in batch using Gemini 3.6 Flash.
 */
async function translateWithGemini(items) {
  const ai = getGeminiClient();
  if (!ai) return null;

  const promptItems = items.map((item, idx) => {
    const rawName = typeof item.name === "object" ? (item.name.English || Object.values(item.name)[0] || "") : item.name;
    const rawDesc = typeof item.description === "object" ? (item.description.English || Object.values(item.description)[0] || "") : item.description || "";
    return {
      index: idx,
      name: String(rawName || "").trim(),
      description: String(rawDesc || "").trim(),
      languages: item.languages || item.missingLanguages || ["Russian", "German", "Spanish", "Kazakh", "Hebrew", "Japanese", "Korean"]
    };
  });

  const prompt = `You are a culinary translator for a luxury restaurant.
Translate the following dish names and optional descriptions into the specified languages.
Rules:
1. Authentic gastronomic vocabulary.
2. If description is empty, keep description as "".
3. Return ONLY a valid JSON array matching the items by index:
[
  {
    "index": 0,
    "name": { "Russian": "...", "German": "...", "Spanish": "...", "Kazakh": "...", "Hebrew": "...", "Japanese": "...", "Korean": "..." },
    "description": { "Russian": "...", "German": "...", "Spanish": "...", "Kazakh": "...", "Hebrew": "...", "Japanese": "...", "Korean": "..." }
  }
]

Items:
${JSON.stringify(promptItems, null, 2)}`;

  const result = await ai.models.generateContent({
    model: "gemini-3.6-flash",
    contents: prompt,
  });

  let rawText = result.text?.trim() || "";
  rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(rawText);

  return items.map((_, idx) => {
    const found = parsed.find((p) => p.index === idx) || parsed[idx] || {};
    const nameMap = found.name || {};
    const descMap = found.description || {};
    const translations = {};

    for (const lang of SUPPORTED_LANGUAGES) {
      const tName = nameMap[lang.name] || nameMap[lang.code] || "";
      const tDesc = descMap[lang.name] || descMap[lang.code] || "";
      translations[lang.code] = {
        name: tName,
        description: tDesc,
      };
    }

    return {
      name: nameMap,
      description: descMap,
      translations,
    };
  });
}

/**
 * Translates a single menu item using Google Translate fallback.
 */
export async function translateMenuItem({ name, description, targetLanguages = [] }) {
  const cleanName = String(name || "").trim();
  const cleanDesc = String(description || "").trim();
  const hasDesc = cleanDesc.length > 0;

  let languagesToProcess = SUPPORTED_LANGUAGES;
  if (Array.isArray(targetLanguages) && targetLanguages.length > 0) {
    languagesToProcess = targetLanguages
      .map((l) => LANG_MAP.get(String(l).trim().toLowerCase()))
      .filter(Boolean);
  }

  const resultNameByLang = {};
  const resultDescByLang = {};
  const resultByCode = {};

  for (const lang of languagesToProcess) {
    let transName = "";
    let transDesc = "";

    if (cleanName) {
      if (lang.code === "ru" && russianDictionary[cleanName.toLowerCase()]) {
        transName = russianDictionary[cleanName.toLowerCase()];
      } else {
        try {
          const res = await translate(cleanName, { to: lang.code === "he" ? "iw" : lang.code });
          transName = res.text || cleanName;
        } catch (err) {
          console.warn(`Translation error for name "${cleanName}" (${lang.name}):`, err.message);
          transName = cleanName;
        }
      }
    }

    if (hasDesc) {
      if (lang.code === "ru" && russianDictionary[cleanDesc.toLowerCase()]) {
        transDesc = russianDictionary[cleanDesc.toLowerCase()];
      } else {
        try {
          const res = await translate(cleanDesc, { to: lang.code === "he" ? "iw" : lang.code });
          transDesc = res.text || cleanDesc;
        } catch (err) {
          console.warn(`Translation error for desc "${cleanDesc}" (${lang.name}):`, err.message);
          transDesc = cleanDesc;
        }
      }
    } else {
      transDesc = "";
    }

    resultNameByLang[lang.name] = transName;
    resultDescByLang[lang.name] = transDesc;
    resultByCode[lang.code] = { name: transName, description: transDesc };
  }

  return {
    name: resultNameByLang,
    description: resultDescByLang,
    translations: resultByCode,
  };
}

/**
 * Translates a batch of menu items with Gemini first, falling back to Google Translate.
 */
export async function translateBatch(items) {
  try {
    const geminiResults = await translateWithGemini(items);
    if (geminiResults && geminiResults.length === items.length) {
      return geminiResults;
    }
  } catch (err) {
    console.warn("Gemini batch translation failed, using fallback:", err.message);
  }

  const results = [];
  for (const item of items) {
    const rawName = typeof item.name === "object" ? (item.name.English || Object.values(item.name)[0] || "") : item.name;
    const rawDesc = typeof item.description === "object" ? (item.description.English || Object.values(item.description)[0] || "") : item.description;

    const res = await translateMenuItem({
      name: rawName,
      description: rawDesc,
      targetLanguages: item.languages || item.missingLanguages || [],
    });
    results.push(res);
  }
  return results;
}
