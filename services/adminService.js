import crypto from "crypto";
import { calculateAuthoritativeBill } from "./billCalculationService.js";
import {
  getOrLoadMenu,
  invalidateMenuCache,
  initMenuVersion,
  getCurrentMenuVersion,
  setCurrentMenuVersion,
} from "./menuCache.js";
import { getAdminTables, invalidateTableCache } from "./tableCache.js";

const RESTAURANT_PATH = ["restaurants", "rustic-charm"];

function isSqliteDb(db) {
  return !!db && typeof db.all === "function" && typeof db.run === "function" && !db.collection;
}

function categoriesCollection(db) {
  return db.collection(...RESTAURANT_PATH).doc("rustic-charm").collection("categories");
}

function menuCollection(db) {
  return db.collection("restaurant_menu");
}

function tablesCollection(db) {
  return db.collection(...RESTAURANT_PATH).doc("rustic-charm").collection("tables");
}

function ordersCollection(db) {
  return db.collection(...RESTAURANT_PATH).doc("rustic-charm").collection("orders");
}

function waitersCollection(db) {
  return db.collection(...RESTAURANT_PATH).doc("rustic-charm").collection("waiters");
}

function waiterCallsCollection(db) {
  return db.collection(...RESTAURANT_PATH).doc("rustic-charm").collection("waiterCalls");
}

const toBoolean = (value) => value === 1 || value === true || value === "1";

function parseJsonField(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeMenuText(value) {
  if (value && typeof value === "object") {
    return String(value.English || value.en || value.english || Object.values(value)[0] || "").trim();
  }
  const str = String(value ?? "").trim();
  if (str.startsWith("{") && str.endsWith("}")) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === "object") {
        return String(parsed.English || parsed.en || parsed.english || Object.values(parsed)[0] || "").trim();
      }
    } catch { }
  }
  return str;
}

/**
 * Resolves a category name or ID to its { id, name } row.
 * Returns { id, name } when found, or { id: null, name: candidateName } when not found
 * so the plain name can always be stored on the menu item as a fallback.
 */
async function resolveCategoryInfo(db, categoryOrId) {
  if (!categoryOrId) return { id: null, name: null };
  const candidate = String(categoryOrId).trim();
  if (!candidate) return { id: null, name: null };

  // Skip JSON-encoded strings - extract the English name
  let lookupName = candidate;
  if (candidate.startsWith('{')) {
    try {
      const parsed = JSON.parse(candidate);
      lookupName = parsed.English || parsed.en || Object.values(parsed)[0] || candidate;
    } catch { /* use as-is */ }
  }

  if (isSqliteDb(db)) {
    // 1. Try by exact id first
    const byId = await db.get("SELECT id, name FROM categories WHERE id = ? LIMIT 1", [lookupName]);
    if (byId?.id) return { id: byId.id, name: byId.name };

    // 2. Try slug ID (e.g. "Soups" -> "cat-soups")
    const slugId = "cat-" + lookupName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const bySlug = await db.get("SELECT id, name FROM categories WHERE id = ? LIMIT 1", [slugId]);
    if (bySlug?.id) return { id: bySlug.id, name: bySlug.name };

    // 3. Match against categories table by parsing localized JSON names and slug variations
    const allCats = await db.all("SELECT id, name FROM categories");
    const target = lookupName.toLowerCase().trim();
    const cleanTarget = target.replace(/^cat-/, "").replace(/[^a-z0-9]/g, "");

    for (const c of allCats) {
      if (c.id.toLowerCase() === target) return { id: c.id, name: c.name };
      const cleanCId = c.id.toLowerCase().replace(/^cat-/, "").replace(/[^a-z0-9]/g, "");
      if (cleanCId && cleanTarget && cleanCId === cleanTarget) {
        return { id: c.id, name: c.name };
      }

      try {
        const parsed = JSON.parse(c.name);
        for (const val of Object.values(parsed)) {
          if (typeof val === "string") {
            const vLow = val.toLowerCase().trim();
            if (vLow === target || (cleanTarget && vLow.replace(/[^a-z0-9]/g, "") === cleanTarget)) {
              return { id: c.id, name: c.name };
            }
          }
        }
      } catch {
        const cLow = c.name.toLowerCase().trim();
        if (cLow === target || (cleanTarget && cLow.replace(/[^a-z0-9]/g, "") === cleanTarget)) {
          return { id: c.id, name: c.name };
        }
      }
    }

    // Not found — return null id but keep the plain name as fallback
    return { id: null, name: lookupName };
  }

  const snapshotById = await categoriesCollection(db).where("id", "==", lookupName).limit(1).get();
  if (!snapshotById.empty) {
    const d = snapshotById.docs[0];
    return { id: d.id, name: d.data().name };
  }
  const snapshotByName = await categoriesCollection(db).where("name", "==", lookupName).limit(1).get();
  if (!snapshotByName.empty) {
    const d = snapshotByName.docs[0];
    return { id: d.id, name: d.data().name };
  }
  return { id: null, name: lookupName };
}

/** Legacy helper kept for backwards compat — returns only the id. */
async function resolveCategoryId(db, categoryOrId) {
  const info = await resolveCategoryInfo(db, categoryOrId);
  return info.id;
}

/**
 * Safely adds the category_name column to menu_items if it doesn't exist yet,
 * then backfills any rows that have no category_id (orphaned by a deleted category)
 * or that already have category_id but no category_name stored.
 */
let _categoryNameColumnEnsured = false;
async function ensureCategoryNameColumn(db) {
  if (!isSqliteDb(db) || _categoryNameColumnEnsured) return;
  _categoryNameColumnEnsured = true;
  try {
    await db.run("ALTER TABLE menu_items ADD COLUMN category_name TEXT DEFAULT ''");
  } catch (e) {
    // Column already exists — that's fine
  }
  // Backfill: for items that have category_id, set category_name from the categories table
  await db.run(`
    UPDATE menu_items
    SET category_name = (
      SELECT name FROM categories WHERE categories.id = menu_items.category_id
    )
    WHERE category_id IS NOT NULL AND (category_name IS NULL OR category_name = '')
  `);
}

export async function getCategories(db) {
  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM categories ORDER BY display_order ASC, LOWER(name) ASC");
    return rows.map((row) => ({
      id: row.id,
      name: parseJsonField(row.name),
      isActive: toBoolean(row.is_active),
      displayOrder: Number(row.display_order || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  const snapshot = await categoriesCollection(db).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
}

export async function addCategory(db, category) {
  if (isSqliteDb(db)) {
    const id = category.id || crypto.randomUUID();
    const data = {
      id,
      name: typeof category.name === "object" ? JSON.stringify(category.name) : (category.name || ""),
      is_active: category.isActive === false ? 0 : 1,
      display_order: Number(category.displayOrder ?? 0),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await db.run(
      "INSERT INTO categories (id, name, is_active, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [data.id, data.name, data.is_active, data.display_order, data.created_at, data.updated_at]
    );
    await incrementMenuVersion(db);
    return { id: data.id, name: data.name, isActive: toBoolean(data.is_active), displayOrder: data.display_order };
  }

  const data = {
    name: typeof category.name === "object" ? JSON.stringify(category.name) : (category.name || ""),
    isActive: category.isActive !== false,
    displayOrder: category.displayOrder ?? 0,
  };
  const docRef = await categoriesCollection(db).add(data);
  await incrementMenuVersion(db);
  return { id: docRef.id, ...data };
}

export async function updateCategory(db, id, category) {
  if (!id) throw new Error("Category ID is required");
  if (isSqliteDb(db)) {
    const entries = Object.entries({
      name: category.name !== undefined ? (typeof category.name === "object" ? JSON.stringify(category.name) : category.name) : undefined,
      is_active: category.isActive === undefined ? undefined : category.isActive ? 1 : 0,
      display_order: category.displayOrder,
      updated_at: new Date().toISOString(),
    }).filter(([, value]) => value !== undefined);
    if (!entries.length) return { id, ...category };
    const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
    const params = entries.map(([, value]) => value);
    params.push(id);
    await db.run(`UPDATE categories SET ${clauses} WHERE id = ?`, params);
    // Also update category_name in menu_items if category name was updated
    if (category.name) {
      await db.run("UPDATE menu_items SET category_name = ? WHERE category_id = ?", [category.name, id]);
    }
    await incrementMenuVersion(db);
    return { id, ...category };
  }
  await categoriesCollection(db).doc(id).update(category);
  await incrementMenuVersion(db);
  return { id, ...category };
}

export async function deleteCategory(db, id) {
  if (!id) throw new Error("Category ID is required");
  if (isSqliteDb(db)) {
    await ensureCategoryNameColumn(db);
    await db.run("UPDATE menu_items SET category_name = '' WHERE category_id = ?", [id]);
    await db.run("DELETE FROM categories WHERE id = ?", [id]);
    await incrementMenuVersion(db);
    return { id };
  }
  await categoriesCollection(db).doc(id).delete();
  await incrementMenuVersion(db);
  return { id };
}

export async function fetchMenuItemsFromDb(db, lang) {
  if (isSqliteDb(db)) {
    const rows = await db.all(
      `SELECT menu_items.*, categories.name AS cat_join_name
       FROM menu_items
       LEFT JOIN categories ON menu_items.category_id = categories.id
       ORDER BY menu_items.created_at DESC`
    );

    const langMap = {
      english: "en",
      russian: "ru",
      german: "de",
      spanish: "es",
      kazakh: "kk",
      hebrew: "he",
      japanese: "ja",
      korean: "ko",
      en: "en",
      ru: "ru",
      de: "de",
      es: "es",
      kk: "kk",
      he: "he",
      ja: "ja",
      ko: "ko",
    };
    const targetLang = lang ? langMap[String(lang).toLowerCase().trim()] || String(lang).toLowerCase().trim() : null;

    let translationsMap = {};
    if (targetLang && targetLang !== "en") {
      // Query ONLY the requested language's translations
      const translationsRows = await db.all(
        `SELECT menu_item_id, language_code, name, description FROM menu_translations WHERE language_code = ?`,
        [targetLang]
      );
      for (const trans of translationsRows) {
        if (!translationsMap[trans.menu_item_id]) {
          translationsMap[trans.menu_item_id] = {};
        }
        translationsMap[trans.menu_item_id][trans.language_code] = {
          name: trans.name,
          description: trans.description,
        };
      }
    } else if (!targetLang) {
      // No language specified: backward compatible full translations for Admin
      const translationsRows = await db.all(
        `SELECT menu_item_id, language_code, name, description FROM menu_translations`
      );
      for (const trans of translationsRows) {
        if (!translationsMap[trans.menu_item_id]) {
          translationsMap[trans.menu_item_id] = {};
        }
        translationsMap[trans.menu_item_id][trans.language_code] = {
          name: trans.name,
          description: trans.description,
        };
      }
    }
    // If targetLang === 'en', translationsMap stays {} because English is stored directly in menu_items

    return rows.map((row) => {
      const transObj = translationsMap[row.id] || {};
      const localized = targetLang && targetLang !== "en" ? transObj[targetLang] : null;

      const rawName = parseJsonField(row.name);
      const rawDesc = parseJsonField(row.description) || "";
      const itemName = localized?.name || (typeof rawName === "object" && rawName !== null ? (rawName[targetLang || "en"] || rawName.en || rawName.English || Object.values(rawName)[0]) : rawName);

      let itemDesc = "";
      if (localized?.description) {
        itemDesc = String(localized.description).trim();
      } else if (typeof rawDesc === "object" && rawDesc !== null) {
        if (targetLang && targetLang !== "en") {
          itemDesc = rawDesc[targetLang] || Object.entries(rawDesc).find(([k]) => k.toLowerCase() === targetLang.toLowerCase())?.[1] || "";
        } else {
          itemDesc = rawDesc.English || rawDesc.en || rawDesc.english || "";
        }
      } else {
        const strDesc = String(rawDesc || "").trim();
        if (strDesc.startsWith("{") && strDesc.endsWith("}")) {
          try {
            const parsed = JSON.parse(strDesc);
            if (parsed && typeof parsed === "object") {
              if (targetLang && targetLang !== "en") {
                itemDesc = parsed[targetLang] || Object.entries(parsed).find(([k]) => k.toLowerCase() === targetLang.toLowerCase())?.[1] || "";
              } else {
                itemDesc = parsed.English || parsed.en || parsed.english || "";
              }
            }
          } catch {
            itemDesc = "";
          }
        } else {
          itemDesc = strDesc === "[object Object]" ? "" : (targetLang && targetLang !== "en" ? "" : strDesc);
        }
      }

      const rawCat = parseJsonField(row.cat_join_name || row.category_name || "");
      const codeToNameMap = {
        en: "english",
        ru: "russian",
        de: "german",
        es: "spanish",
        kk: "kazakh",
        he: "hebrew",
        ja: "japanese",
        ko: "korean",
      };
      const fullTargetLang = targetLang ? codeToNameMap[targetLang] || targetLang : null;

      let englishCategory = "";
      let itemCategory = "";

      if (typeof rawCat === "object" && rawCat !== null) {
        englishCategory = rawCat.English || rawCat.en || rawCat.english || Object.values(rawCat)[0] || "";
        if (targetLang && targetLang !== "en") {
          itemCategory =
            rawCat[targetLang] ||
            (fullTargetLang ? rawCat[fullTargetLang] || Object.entries(rawCat).find(([k]) => k.toLowerCase() === fullTargetLang)?.[1] : null) ||
            Object.entries(rawCat).find(([k]) => k.toLowerCase() === targetLang.toLowerCase())?.[1] ||
            englishCategory;
        } else {
          itemCategory = englishCategory;
        }
      } else {
        const strCat = String(rawCat || "").trim();
        if (strCat.startsWith("{") && strCat.endsWith("}")) {
          try {
            const parsed = JSON.parse(strCat);
            if (parsed && typeof parsed === "object") {
              englishCategory = parsed.English || parsed.en || parsed.english || Object.values(parsed)[0] || "";
              if (targetLang && targetLang !== "en") {
                itemCategory =
                  parsed[targetLang] ||
                  (fullTargetLang ? parsed[fullTargetLang] || Object.entries(parsed).find(([k]) => k.toLowerCase() === fullTargetLang)?.[1] : null) ||
                  Object.entries(parsed).find(([k]) => k.toLowerCase() === targetLang.toLowerCase())?.[1] ||
                  englishCategory;
              } else {
                itemCategory = englishCategory;
              }
            }
          } catch {
            itemCategory = "";
            englishCategory = "";
          }
        } else {
          const plain = strCat === "[object Object]" ? "" : strCat;
          englishCategory = plain;
          itemCategory = plain;
        }
      }

      const isItemAvailable = toBoolean(row.is_available);

      return {
        id: row.id,
        categoryId: row.category_id,
        category: englishCategory || itemCategory || row.category_name || row.category_id || "",
        categoryLocalized: itemCategory || englishCategory || "",
        name: itemName,
        description: itemDesc,
        price: Number(row.price || 0),
        imageUrl: row.image_url || "",
        image: row.image_url || "",
        isVeg: toBoolean(row.is_veg),
        isAvailable: isItemAvailable,
        available: isItemAvailable,
        isPopular: toBoolean(row.is_popular),
        prepTime: row.prep_time,
        rating: Number(row.rating || 0),
        metadata: row.metadata ? parseJsonField(row.metadata) : {},
        priceOptions: row.metadata ? parseJsonField(row.metadata).priceOptions : undefined,
        translations: transObj,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }
  const snapshot = await menuCollection(db).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function getMenuItems(db, lang, options = {}) {
  if (options && options.skipCache) {
    return fetchMenuItemsFromDb(db, lang);
  }
  return getOrLoadMenu(db, lang, fetchMenuItemsFromDb);
}

export async function addMenuItem(db, item) {
  if (isSqliteDb(db)) {
    const id = item.id || crypto.randomUUID();
    const catInfo = await resolveCategoryInfo(db, item.categoryId ?? item.category_id ?? item.category);
    // Ensure the category_name column exists (safe migration)
    await ensureCategoryNameColumn(db);
    const payload = {
      id,
      category_id: catInfo.id,
      category_name: catInfo.name || "",
      name: normalizeMenuText(item.name || ""),
      description: normalizeMenuText(item.description || ""),
      price: Number(item.price || 0),
      image_url: item.imageUrl || item.image_url || "",
      is_veg: item.isVeg === false ? 0 : 1,
      is_available: item.isAvailable === false ? 0 : 1,
      is_popular: item.isPopular ? 1 : 0,
      prep_time: item.prepTime ?? null,
      rating: Number(item.rating || 0),
      metadata: JSON.stringify({ ...(item.metadata || {}), priceOptions: item.priceOptions }),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await db.run(
      "INSERT INTO menu_items (id, category_id, category_name, name, description, price, image_url, is_veg, is_available, is_popular, prep_time, rating, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [payload.id, payload.category_id, payload.category_name, payload.name, payload.description, payload.price, payload.image_url, payload.is_veg, payload.is_available, payload.is_popular, payload.prep_time, payload.rating, payload.metadata, payload.created_at, payload.updated_at]
    );

    // Save translations if provided
    if (item.translations && typeof item.translations === "object") {
      for (const [languageCode, translation] of Object.entries(item.translations)) {
        if (languageCode === "en" || !translation || typeof translation !== "object") continue; // Skip English
        const transId = crypto.randomUUID();
        const transName = typeof translation === "object" ? translation.name : translation;
        const transDesc = typeof translation === "object" ? translation.description : "";

        if (transName) {
          await db.run(
            "INSERT OR REPLACE INTO menu_translations (id, menu_item_id, language_code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [transId, id, languageCode, transName, transDesc || "", new Date().toISOString(), new Date().toISOString()]
          );
        }
      }
    }

    await incrementMenuVersion(db);
    return { id: payload.id, ...item };
  }
  const docRef = await menuCollection(db).add(item);
  await incrementMenuVersion(db);
  return { id: docRef.id, ...item };
}

export async function updateMenuItem(db, id, item) {
  if (!id) throw new Error("Menu item ID is required");
  if (isSqliteDb(db)) {
    await ensureCategoryNameColumn(db);
    const rawCategory = item.categoryId ?? item.category_id ?? item.category;
    const catInfo = rawCategory !== undefined
      ? await resolveCategoryInfo(db, rawCategory)
      : null;
    const entries = Object.entries({
      category_id: catInfo ? catInfo.id : undefined,
      category_name: catInfo ? (catInfo.name || "") : undefined,
      name: item.name !== undefined ? normalizeMenuText(item.name) : undefined,
      description: item.description !== undefined ? normalizeMenuText(item.description) : undefined,
      price: item.price,
      image_url: item.imageUrl ?? item.image_url,
      is_veg: item.isVeg === undefined ? undefined : item.isVeg ? 1 : 0,
      is_available: item.isAvailable === undefined ? undefined : item.isAvailable ? 1 : 0,
      is_popular: item.isPopular === undefined ? undefined : item.isPopular ? 1 : 0,
      prep_time: item.prepTime,
      rating: item.rating,
      metadata: (item.metadata || item.priceOptions !== undefined) ? JSON.stringify({ ...(item.metadata || {}), priceOptions: item.priceOptions }) : undefined,
      updated_at: new Date().toISOString(),
    }).filter(([, value]) => value !== undefined);
    if (entries.length > 0) {
      const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
      const params = entries.map(([, value]) => value);
      params.push(id);
      await db.run(`UPDATE menu_items SET ${clauses} WHERE id = ?`, params);
    }

    // Update translations if provided
    if (item.translations && typeof item.translations === "object") {
      for (const [languageCode, translation] of Object.entries(item.translations)) {
        if (languageCode === "en" || !translation || typeof translation !== "object") continue; // Skip English
        const transName = typeof translation === "object" ? translation.name : translation;
        const transDesc = typeof translation === "object" ? translation.description : "";

        if (transName) {
          // Check if translation exists
          const existing = await db.get(
            "SELECT id FROM menu_translations WHERE menu_item_id = ? AND language_code = ? LIMIT 1",
            [id, languageCode]
          );

          if (existing) {
            // Update existing translation
            await db.run(
              "UPDATE menu_translations SET name = ?, description = ?, updated_at = ? WHERE menu_item_id = ? AND language_code = ?",
              [transName, transDesc || "", new Date().toISOString(), id, languageCode]
            );
          } else {
            // Insert new translation
            const transId = crypto.randomUUID();
            await db.run(
              "INSERT INTO menu_translations (id, menu_item_id, language_code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [transId, id, languageCode, transName, transDesc || "", new Date().toISOString(), new Date().toISOString()]
            );
          }
        } else {
          // Delete translation if empty
          await db.run(
            "DELETE FROM menu_translations WHERE menu_item_id = ? AND language_code = ?",
            [id, languageCode]
          );
        }
      }
    }

    await incrementMenuVersion(db);
    return { id, ...item };
  }
  await menuCollection(db).doc(id).update(item);
  await incrementMenuVersion(db);
  return { id, ...item };
}

export async function deleteMenuItem(db, id) {
  if (!id) throw new Error("Menu item ID is required");
  if (isSqliteDb(db)) {
    await db.run("DELETE FROM menu_items WHERE id = ?", [id]);
    await incrementMenuVersion(db);
    return { id };
  }
  await menuCollection(db).doc(id).delete();
  await incrementMenuVersion(db);
  return { id };
}

export async function getTables(db) {
  return await getAdminTables(db);
}

export async function createTable(db, tableData) {
  const { area, areaLabel, tableNumber } = tableData;
  if (!area || !tableNumber) {
    throw new Error("Table area and table number are required");
  }

  if (isSqliteDb(db)) {
    const normalizedArea = String(area).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "table";
    const tableKey = `${normalizedArea}-${tableNumber}`;

    const existing = await db.get(
      "SELECT * FROM tables WHERE table_key = ? OR (area = ? AND table_number = ?) LIMIT 1",
      [tableKey, normalizedArea, Number(tableNumber)]
    );

    if (existing) {
      return {
        id: existing.id,
        tableKey: existing.table_key,
        tableNumber: Number(existing.table_number),
        area: existing.area,
        areaLabel: existing.area_label || existing.area,
        displayName: existing.display_name || `${existing.area_label || existing.area} - Table ${existing.table_number}`,
        occupied: existing.occupied === 1 || existing.occupied === true,
        status: existing.status || "available",
        currentOrderId: existing.current_order_id || "",
        currentSessionId: existing.current_session_id || "",
      };
    }

    const data = {
      id: tableKey,
      table_key: tableKey,
      table_number: Number(tableNumber),
      area: normalizedArea,
      area_label: areaLabel || area,
      display_name: `${areaLabel || area} - Table ${tableNumber}`,
      occupied: 0,
      status: "available",
      current_order_id: "",
      current_session_id: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await db.run(
      "INSERT INTO tables (id, table_key, table_number, area, area_label, display_name, occupied, status, current_order_id, current_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [data.id, data.table_key, data.table_number, data.area, data.area_label, data.display_name, data.occupied, data.status, data.current_order_id, data.current_session_id, data.created_at, data.updated_at]
    );
    invalidateTableCache();
    return { id: data.id, tableKey: data.table_key, tableNumber: data.table_number, area: data.area, areaLabel: data.area_label, displayName: data.display_name, occupied: false, status: "available" };
  }

  const normalizedArea = String(area).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const tableKey = `${normalizedArea || "table"}-${tableNumber}`;

  const data = {
    id: tableKey,
    tableNumber,
    area: normalizedArea,
    areaLabel: areaLabel || area,
    displayName: `${areaLabel || area} - Table ${tableNumber}`,
    tableKey,
    occupied: false,
    status: "available",
    currentOrderId: "",
    currentSessionId: "",
  };

  await tablesCollection(db).doc(tableKey).set(data, { merge: true });
  invalidateTableCache();
  return data;
}

export async function updateTable(db, id, updates) {
  if (!id) throw new Error("Table ID is required");
  if (isSqliteDb(db)) {
    const entries = Object.entries({
      table_key: updates.tableKey,
      table_number: updates.tableNumber,
      area: updates.area,
      area_label: updates.areaLabel,
      display_name: updates.displayName,
      occupied: updates.occupied === undefined ? undefined : updates.occupied ? 1 : 0,
      status: updates.status,
      current_order_id: updates.currentOrderId,
      current_session_id: updates.currentSessionId,
      updated_at: new Date().toISOString(),
    }).filter(([, value]) => value !== undefined);
    if (!entries.length) return { id, ...updates };
    const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
    const params = entries.map(([, value]) => value);
    params.push(id);
    await db.run(`UPDATE tables SET ${clauses} WHERE id = ?`, params);

    // When a table is freed, end its active session and ensure active order is saved as Completed for all Excel reports
    if (updates.status === 'available' || updates.occupied === false || updates.occupied === 0) {
      const now = new Date().toISOString();
      await db.run("UPDATE sessions SET status = 'completed', updated_at = ? WHERE table_id = ? AND status = 'active'", [now, id]);
      await db.run(
        `UPDATE orders 
         SET status = 'Completed', 
             payment_status = 'Paid',
             payment_method = CASE WHEN payment_method IS NOT NULL AND payment_method != '' THEN payment_method ELSE 'Cash' END,
             completed_at = COALESCE(completed_at, ?), 
             updated_at = ? 
         WHERE table_id = ? AND status NOT IN ('Completed', 'Cancelled', 'Rejected')`,
        [now, now, id]
      );
    }

    invalidateTableCache();
    return { id, ...updates };
  }
  await tablesCollection(db).doc(id).update(updates);
  invalidateTableCache();
  return { id, ...updates };
}

export async function deleteTable(db, id) {
  if (!id) throw new Error("Table ID is required");
  if (isSqliteDb(db)) {
    await db.run("DELETE FROM tables WHERE id = ?", [id]);
    invalidateTableCache();
    return { id };
  }
  await tablesCollection(db).doc(id).delete();
  invalidateTableCache();
  return { id };
}

export async function getOrders(db, { includeCompleted = false, forReports = false } = {}) {
  if (isSqliteDb(db)) {
    let whereClause = "";
    if (forReports) {
      whereClause = "WHERE status NOT IN ('Cancelled', 'Rejected')";
    } else if (includeCompleted) {
      whereClause = "WHERE status NOT IN ('Cancelled', 'Rejected') AND (archived = 0 OR archived IS NULL)";
    } else {
      whereClause = "WHERE status NOT IN ('Completed', 'Cancelled', 'Rejected') AND (archived = 0 OR archived IS NULL)";
    }
    const rows = await db.all(
      `SELECT o.*, w.name AS lookup_waiter_name 
       FROM orders o 
       LEFT JOIN waiters w ON o.waiter_id = w.id 
       ${whereClause.replace(/\bstatus\b/g, 'o.status').replace(/\barchived\b/g, 'o.archived')} 
       ORDER BY o.created_at DESC`
    );
    if (!rows || rows.length === 0) {
      return [];
    }

    const orderIds = rows.map((r) => r.id);
    const placeholders = orderIds.map(() => "?").join(", ");
    const itemsRows = await db.all(
      `SELECT
          oi.*,
          COALESCE(c.name, mi.category_name, '') AS category_name,
          COALESCE(c.id, mi.category_id, '')     AS category_id,
          mi.category_name                       AS mi_category_name,
          mi.category_id                         AS mi_category_id
       FROM order_items oi
       LEFT JOIN menu_items mi ON (oi.menu_item_id = mi.id OR (oi.menu_item_id IS NULL AND LOWER(TRIM(oi.name)) = LOWER(TRIM(mi.name))))
       LEFT JOIN categories c ON mi.category_id = c.id
       WHERE oi.order_id IN (${placeholders})
       ORDER BY oi.created_at ASC`,
      orderIds
    );

    const itemsByOrderId = new Map();
    for (const item of itemsRows) {
      const resolvedItem = {
        ...item,
        category: item.category_name || item.mi_category_name || "",
        categoryId: item.category_id || item.mi_category_id || "",
      };
      const list = itemsByOrderId.get(item.order_id);
      if (list) {
        list.push(resolvedItem);
      } else {
        itemsByOrderId.set(item.order_id, [resolvedItem]);
      }
    }

    const orders = [];
    for (const row of rows) {
      const items = itemsByOrderId.get(row.id) || [];
      orders.push({
        id: row.id,
        sessionId: row.session_id,
        tableId: row.table_id,
        tableReference: row.table_reference,
        tableNumber: Number(row.table_number || 0),
        tableArea: row.table_area,
        tableLabel: row.table_label,
        orderNumber: row.order_number,
        status: row.status,
        orderSource: row.order_source,
        total: Number(row.total || 0),
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method,
        paymentSplits: row.payment_splits ? (typeof row.payment_splits === "string" ? JSON.parse(row.payment_splits) : row.payment_splits) : null,
        tipAmount: Number(row.tip_amount || 0),
        discountType: row.discount_type,
        discountValue: row.discount_value,
        discountAmount: row.discount_amount,
        finalTotal: row.final_total,
        discountMode: row.discount_mode,
        foodDiscountPercent: row.food_discount_percent,
        alcoholDiscountPercent: row.alcohol_discount_percent,
        foodDiscountAmount: row.food_discount_amount,
        alcoholDiscountAmount: row.alcohol_discount_amount,
        waiterId: row.waiter_id,
        waiterName: row.waiter_name || row.lookup_waiter_name || null,
        description: row.description,
        acceptedAt: row.accepted_at,
        servedAt: row.served_at,
        completedAt: row.completed_at,
        archived: Boolean(row.archived),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastPrintedItems: row.last_printed_items ? (typeof row.last_printed_items === "string" ? JSON.parse(row.last_printed_items) : row.last_printed_items) : null,
        items: items.map((item) => ({
          id: item.id,
          menuItemId: item.menu_item_id,
          name: item.name,
          category: item.category_name || "",
          categoryId: item.category_id || "",
          quantity: Number(item.quantity || 0),
          price: Number(item.price || 0),
          specialInstructions: item.special_instructions || "",
        })),
      });
    }
    return orders;
  }

  const snapshot = await ordersCollection(db).orderBy("createdAt", "desc").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function createAdminOrder(db, order) {
  if (!order?.tableId || !order?.waiterId || !Array.isArray(order.items) || order.items.length === 0) {
    throw new Error("Waiter, table, and at least one item are required");
  }
  if (!isSqliteDb(db)) throw new Error("SQLite-backed backend requires SQLite database access");
  const table = await db.get("SELECT * FROM tables WHERE id = ?", [order.tableId]);
  const waiter = await db.get("SELECT * FROM waiters WHERE id = ?", [order.waiterId]);
  if (!table || !waiter || waiter.active === 0 || waiter.is_active === 0) throw new Error("Selected waiter or table was not found");

  if (table.occupied && table.current_order_id) {
    const existingOrder = await db.get(
      "SELECT id, order_number FROM orders WHERE id = ? AND status NOT IN ('Completed', 'Cancelled')",
      [table.current_order_id]
    );
    if (existingOrder) {
      await addOrderItems(db, existingOrder.id, order.items, order.description);
      return { id: existingOrder.id, orderNumber: existingOrder.order_number, appended: true };
    }
  }

  const id = crypto.randomUUID();
  const orderNumber = await generateOrderNumber(db);
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO orders (id, table_id, table_reference, table_number, table_area, table_label, order_number, order_source, status, total, waiter_id, waiter_name, description, accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, table.id, table.table_key, table.table_number, table.area, table.display_name, orderNumber, "admin", "Accepted", Number(order.total) || 0, waiter.id, waiter.name, order.description || "", now, now, now]
  );
  for (const item of order.items) {
    await db.run(
      "INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, price, special_instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), id, item.menuItemId || null, item.name || "", Math.max(1, Number(item.quantity) || 1), Number(item.price) || 0, "", now]
    );
  }
  await db.run("UPDATE tables SET occupied = 1, status = 'occupied', current_order_id = ?, updated_at = ? WHERE id = ?", [id, now, table.id]);
  invalidateTableCache();
  return { id, orderNumber };
}

export async function deleteAllOrders(db) {
  if (isSqliteDb(db)) {
    // Soft-archive orders so they clear from the active screen but are NEVER lost from reports
    const result = await db.run("UPDATE orders SET archived = 1");
    await db.run(
      "UPDATE tables SET occupied = 0, status = 'available', current_order_id = '', current_session_id = '', updated_at = ?",
      [new Date().toISOString()]
    );
    invalidateTableCache();
    return { count: result.changes };
  }
  const snapshot = await ordersCollection(db).get();
  const updates = snapshot.docs.map((doc) => ordersCollection(db).doc(doc.id).update({ archived: 1 }));
  await Promise.all(updates);
  return { count: updates.length };
}

export async function deleteAllCompletedOrders(db) {
  if (isSqliteDb(db)) {
    // Soft-archive completed orders so they clear from the active screen but are NEVER lost from reports
    const result = await db.run(
      "UPDATE orders SET archived = 1 WHERE status IN ('Completed', 'Payment Done', 'Served') OR payment_status = 'Paid'"
    );
    return { count: result.changes };
  }
  const snapshot = await ordersCollection(db).get();
  const updates = snapshot.docs
    .filter((doc) => {
      const d = doc.data();
      return d.status === "Completed" || d.status === "Payment Done" || d.paymentStatus === "Paid";
    })
    .map((doc) => ordersCollection(db).doc(doc.id).update({ archived: 1 }));
  await Promise.all(updates);
  return { count: updates.length };
}

export async function updateOrder(db, id, updates) {
  if (!id) throw new Error("Order ID is required");
  const now = new Date().toISOString();

  if (isSqliteDb(db)) {
    const currentOrder = await db.get("SELECT * FROM orders WHERE id = ?", [id]);
    if (!currentOrder) throw new Error("Order not found");

    // Phase 3: When the bill has been finalized (status = 'Bill Requested'), block
    // any attempt by a client to overwrite the authoritative frozen financial fields.
    // Staff are still allowed to advance the status to 'Payment Done' or 'Completed'.
    if (currentOrder.status === "Bill Requested") {
      const allowedStatusTransitions = new Set(["Payment Done", "Completed"]);
      const requestedStatus = updates.status;
      if (requestedStatus !== undefined && !allowedStatusTransitions.has(requestedStatus)) {
        const err = new Error(
          `Order ${currentOrder.order_number || id} is already in 'Bill Requested' state. ` +
          `Status can only be advanced to 'Payment Done' or 'Completed'.`
        );
        err.status = 409;
        throw err;
      }
      // Strip all financial override fields — the frozen values on the DB row are authoritative.
      const financialFields = [
        "total", "finalTotal", "discountAmount", "discountMode", "discountType",
        "discountValue", "foodDiscountPercent", "alcoholDiscountPercent",
        "foodDiscountAmount", "alcoholDiscountAmount",
      ];
      financialFields.forEach((f) => delete updates[f]);
    }

    let table;
    if (updates.tableId !== undefined) {
      table = await db.get("SELECT * FROM tables WHERE id = ?", [updates.tableId]);
      if (!table) throw new Error("Selected table was not found");
      const isDiff = table.id !== currentOrder.table_id && (!currentOrder.table_reference || table.table_key !== currentOrder.table_reference);
      if (isDiff && (table.occupied || table.status === 'occupied') && table.current_order_id && table.current_order_id !== id) {
        throw new Error("Selected table is occupied");
      }
    }

    const autoAcceptedAt =
      updates.acceptedAt !== undefined
        ? updates.acceptedAt
        : (updates.status === "Accepted" || updates.status === "Preparing") && !currentOrder.accepted_at
          ? now
          : undefined;

    const autoCompletedAt =
      updates.completedAt !== undefined
        ? updates.completedAt
        : updates.status === "Completed" && !currentOrder.completed_at
          ? now
          : undefined;

    let waiterId = updates.waiterId !== undefined ? updates.waiterId : (updates.waiter?.id !== undefined ? updates.waiter.id : undefined);
    let waiterName = updates.waiterName !== undefined ? updates.waiterName : (updates.waiter?.name !== undefined ? updates.waiter.name : undefined);
    if (waiterId && !waiterName) {
      const w = await db.get("SELECT name FROM waiters WHERE id = ?", [waiterId]);
      if (w && w.name) waiterName = w.name;
    }

    const orderUpdates = {
      session_id: updates.sessionId,
      table_id: table?.id ?? updates.tableId,
      table_reference: table?.table_key ?? updates.tableReference,
      table_number: table ? table.table_number : updates.tableNumber,
      table_area: table ? table.area : updates.tableArea,
      table_label: table ? table.display_name : updates.tableLabel,
      order_number: updates.orderNumber,
      status: updates.status,
      total: updates.total,
      customer_name: updates.customerName,
      customer_phone: updates.customerPhone,
      payment_status: updates.paymentStatus,
      payment_method: updates.paymentMethod,
      payment_splits: updates.paymentSplits !== undefined ? (typeof updates.paymentSplits === "object" ? JSON.stringify(updates.paymentSplits) : updates.paymentSplits) : undefined,
      tip_amount: updates.tipAmount !== undefined ? Number(updates.tipAmount) : undefined,
      discount_type: updates.discountType,
      discount_value: updates.discountValue,
      discount_amount: updates.discountAmount,
      final_total: updates.finalTotal,
      discount_mode: updates.discountMode,
      food_discount_percent: updates.foodDiscountPercent,
      alcohol_discount_percent: updates.alcoholDiscountPercent,
      food_discount_amount: updates.foodDiscountAmount,
      alcohol_discount_amount: updates.alcoholDiscountAmount,
      waiter_id: waiterId,
      waiter_name: waiterName,
      accepted_at: autoAcceptedAt,
      served_at: updates.servedAt,
      completed_at: autoCompletedAt,
      updated_at: now,
    };
    const entries = Object.entries(orderUpdates).filter(([, value]) => value !== undefined);
    if (!entries.length) return { id, ...updates };

    await db.transaction(async (tx) => {
      const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
      const params = entries.map(([, value]) => value);
      params.push(id);
      await tx.run(`UPDATE orders SET ${clauses} WHERE id = ?`, params);

      if (table && (table.id !== currentOrder.table_id || (currentOrder.table_reference && table.table_key !== currentOrder.table_reference))) {
        const oldTableId = currentOrder.table_id || (currentOrder.table_reference ? (await tx.get("SELECT id FROM tables WHERE table_key = ? OR id = ?", [currentOrder.table_reference, currentOrder.table_reference]))?.id : null);

        if (oldTableId && oldTableId !== table.id) {
          const remainingOrders = await tx.get(
            "SELECT COUNT(*) as count FROM orders WHERE (table_id = ? OR table_reference = ?) AND id != ? AND status NOT IN ('Completed', 'Cancelled', 'Rejected') AND archived = 0",
            [oldTableId, currentOrder.table_reference || "", id]
          );
          if (!remainingOrders || Number(remainingOrders.count) === 0) {
            await tx.run(
              "UPDATE tables SET occupied = 0, status = 'available', current_order_id = '', current_session_id = '', updated_at = ? WHERE id = ?",
              [now, oldTableId]
            );
          }
        }

        await tx.run(
          "UPDATE tables SET occupied = 1, status = 'occupied', current_order_id = ?, current_session_id = ?, updated_at = ? WHERE id = ?",
          [id, currentOrder.session_id || "", now, table.id]
        );

        if (currentOrder.session_id) {
          await tx.run(
            "UPDATE sessions SET table_id = ?, table_reference = ?, updated_at = ? WHERE id = ?",
            [table.id, table.table_key, now, currentOrder.session_id]
          );
          await tx.run(
            "UPDATE orders SET table_id = ?, table_reference = ?, table_number = ?, table_area = ?, table_label = ?, updated_at = ? WHERE session_id = ?",
            [table.id, table.table_key, table.table_number, table.area, table.display_name, now, currentOrder.session_id]
          );
        }
      }

      if (updates.status === 'Completed') {
        const targetTableId = updates.tableId || currentOrder.table_id;
        if (targetTableId) {
          await tx.run(
            "UPDATE tables SET occupied = 0, status = 'available', current_order_id = '', current_session_id = '', updated_at = ? WHERE id = ?",
            [now, targetTableId]
          );
        }
        const targetSessionId = updates.sessionId || currentOrder.session_id;
        if (targetSessionId) {
          await tx.run(
            "UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?",
            [now, targetSessionId]
          );
        }
      }
    });

    if (table || updates.status === 'Completed') {
      invalidateTableCache();
    }

    return {
      id,
      waiterId: updates.waiterId !== undefined ? updates.waiterId : currentOrder.waiter_id,
      waiterName: updates.waiterName !== undefined ? updates.waiterName : currentOrder.waiter_name,
      ...updates,
      ...(table
        ? {
          tableId: table.id,
          tableReference: table.table_key,
          tableNumber: table.table_number,
          tableArea: table.area,
          tableLabel: table.display_name,
          table_id: table.id,
          table_reference: table.table_key,
          table_number: table.table_number,
          table_area: table.area,
          table_label: table.display_name,
        }
        : {}),
    };
  }
  await ordersCollection(db).doc(id).update(updates);
  return { id, ...updates };
}

function recalculateOrderTotals(currentOrder, allItems) {
  const newTotal = allItems.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.quantity || 0), 0);
  const updates = { total: newTotal };

  const isCatDiscount = currentOrder.discount_mode === "category";
  if (isCatDiscount) {
    let foodSum = 0;
    let alcSum = 0;
    for (const it of allItems) {
      const catText = String(it.category_name || it.category || "").toLowerCase();
      const isAlc = ["beer", "wine", "liquor", "liqueur", "cocktail", "spirits", "alcohol", "whisky", "whiskey", "vodka", "rum", "gin", "tequila", "brandy"].some(k => catText.includes(k));
      const lineAmt = Number(it.price || 0) * Number(it.quantity || 0);
      if (isAlc) alcSum += lineAmt;
      else foodSum += lineAmt;
    }
    const foodPercent = Math.max(0, Number(currentOrder.food_discount_percent || 0));
    const alcPercent = Math.max(0, Number(currentOrder.alcohol_discount_percent || 0));
    const foodDiscountAmount = Math.round((foodSum * foodPercent) / 100);
    const alcoholDiscountAmount = Math.round((alcSum * alcPercent) / 100);
    const discountAmount = foodDiscountAmount + alcoholDiscountAmount;

    updates.food_discount_amount = foodDiscountAmount;
    updates.alcohol_discount_amount = alcoholDiscountAmount;
    updates.discount_amount = discountAmount;
    updates.final_total = Math.max(0, (foodSum - foodDiscountAmount) + (alcSum - alcoholDiscountAmount));
  } else if (currentOrder.discount_type === "percent" && Number(currentOrder.discount_value) > 0) {
    const discountAmount = Math.round((newTotal * Number(currentOrder.discount_value)) / 100);
    updates.discount_amount = discountAmount;
    updates.final_total = Math.max(0, newTotal - discountAmount);
  } else if (currentOrder.discount_amount !== null && currentOrder.discount_amount !== undefined && Number(currentOrder.discount_amount) > 0) {
    updates.final_total = Math.max(0, newTotal - Number(currentOrder.discount_amount));
  } else if (currentOrder.final_total !== null && currentOrder.final_total !== undefined) {
    updates.final_total = newTotal;
  }
  return updates;
}

/**
 * Adds one or more items to an existing order (used by the "Add Item" flow
 * on both the Admin "View Details" drawer and the Waiter "My Orders" card).
 * Recalculates order total dynamically from order_items.
 */
export async function addOrderItems(db, id, itemsToAdd, description) {
  if (!id) throw new Error("Order ID is required");
  if (!Array.isArray(itemsToAdd) || itemsToAdd.length === 0) {
    throw new Error("At least one item is required");
  }

  if (isSqliteDb(db)) {
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      let currentOrder;
      try {
        currentOrder = await tx.get("SELECT * FROM orders WHERE id = ? FOR UPDATE", [id]);
      } catch {
        currentOrder = await tx.get("SELECT * FROM orders WHERE id = ?", [id]);
      }
      if (!currentOrder) throw new Error("Order not found");

      // Phase 3: Reject item mutations after bill finalization.
      if (currentOrder.status === "Bill Requested") {
        const err = new Error(
          `Order ${currentOrder.order_number || id} has been finalized ('Bill Requested'). ` +
          `Items cannot be added after bill finalization.`
        );
        err.status = 409;
        throw err;
      }

      for (const item of itemsToAdd) {
        const menuItemId = item.menuItemId || null;
        const insertQty = Math.max(1, Number(item.quantity) || 1);
        const insertPrice = Number(item.price) || 0;
        let didUpdate = false;
        if (menuItemId) {
          const existing = await tx.get("SELECT id, quantity FROM order_items WHERE order_id = ? AND menu_item_id = ? AND price = ?", [id, menuItemId, insertPrice]);
          if (existing) {
            await tx.run("UPDATE order_items SET quantity = quantity + ? WHERE id = ?", [insertQty, existing.id]);
            didUpdate = true;
          }
        }
        if (!didUpdate) {
          await tx.run(
            "INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, price, special_instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              crypto.randomUUID(),
              id,
              menuItemId,
              item.name || "",
              insertQty,
              insertPrice,
              "",
              now,
            ]
          );
        }
      }

      const allItems = await tx.all(
        `SELECT order_items.quantity, order_items.price,
                COALESCE(categories.name, menu_items.category_name, '') AS category_name,
                COALESCE(categories.id, menu_items.category_id, '')     AS category_id,
                menu_items.category_name                                AS mi_category_name,
                menu_items.category_id                                  AS mi_category_id
         FROM order_items
         LEFT JOIN menu_items ON (order_items.menu_item_id = menu_items.id OR (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(menu_items.name))))
         LEFT JOIN categories ON menu_items.category_id = categories.id
         WHERE order_items.order_id = ?`,
        [id]
      );
      const totalsUpdates = recalculateOrderTotals(currentOrder, allItems);
      const orderUpdates = { ...totalsUpdates, updated_at: now };
      if (description !== undefined && description !== null && String(description).trim() !== "") {
        orderUpdates.description = String(description).trim();
      }

      const clauses = Object.keys(orderUpdates).map((key) => `${key} = ?`).join(", ");
      const params = [...Object.values(orderUpdates), id];
      await tx.run(`UPDATE orders SET ${clauses} WHERE id = ?`, params);
      await tx.run(`DELETE FROM order_bill_splits WHERE order_id = ?`, [id]);
    });

    const items = await db.all(
      `SELECT order_items.*,
              COALESCE(categories.name, menu_items.category_name, '') AS category_name,
              COALESCE(categories.id, menu_items.category_id, '')     AS category_id,
              menu_items.category_name                                AS mi_category_name,
              menu_items.category_id                                  AS mi_category_id
       FROM order_items
       LEFT JOIN menu_items ON (order_items.menu_item_id = menu_items.id OR (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(menu_items.name))))
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ?
       ORDER BY order_items.created_at ASC`,
      [id]
    );
    const updatedOrderRow = await db.get("SELECT * FROM orders WHERE id = ?", [id]);

    return {
      id,
      waiterId: updatedOrderRow.waiter_id,
      waiterName: updatedOrderRow.waiter_name,
      total: Number(updatedOrderRow.total || 0),
      description: updatedOrderRow.description || "",
      finalTotal:
        updatedOrderRow.final_total !== null && updatedOrderRow.final_total !== undefined
          ? Number(updatedOrderRow.final_total)
          : updatedOrderRow.final_total,
      items: items.map((item) => ({
        id: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        category: item.category_name || "",
        categoryId: item.category_id || "",
        categoryId: item.category_id || "",
        quantity: Number(item.quantity || 0),
        price: Number(item.price || 0),
        specialInstructions: item.special_instructions || "",
      })),
    };
  }

  const docRef = ordersCollection(db).doc(id);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new Error("Order not found");
  const currentData = snapshot.data();
  const currentItems = Array.isArray(currentData.items) ? currentData.items : [];
  const newItems = itemsToAdd.map((item) => ({
    menuItemId: item.menuItemId || null,
    name: item.name || "",
    quantity: Math.max(1, Number(item.quantity) || 1),
    price: Number(item.price) || 0,
  }));
  const mergedItems = [...currentItems, ...newItems];
  const newTotal = mergedItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);

  const updates = { items: mergedItems, total: newTotal };
  if (currentData.discountAmount) {
    updates.finalTotal = Math.max(0, newTotal - Number(currentData.discountAmount));
  }

  await docRef.update(updates);
  return { id, ...updates };
}

/**
 * Removes one or more items from an existing order (used by the "Remove
 * Item" flow on both the Admin "View Details" drawer and the Waiter "My
 * Orders" card). Mirrors addOrderItems -- only deletes the matching
 * order_items rows and recalculates total/finalTotal; never touches any
 * other order field. Refuses to remove every item on an order (the order
 * should be cancelled instead if nothing on it is left).
 */
export async function removeOrderItems(db, id, itemIds) {
  if (!id) throw new Error("Order ID is required");
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new Error("At least one item is required");
  }

  if (isSqliteDb(db)) {
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      let currentOrder;
      try {
        currentOrder = await tx.get("SELECT * FROM orders WHERE id = ? FOR UPDATE", [id]);
      } catch {
        currentOrder = await tx.get("SELECT * FROM orders WHERE id = ?", [id]);
      }
      if (!currentOrder) throw new Error("Order not found");

      // Phase 3: Reject item mutations after bill finalization.
      if (currentOrder.status === "Bill Requested") {
        const err = new Error(
          `Order ${currentOrder.order_number || id} has been finalized ('Bill Requested'). ` +
          `Items cannot be removed after bill finalization.`
        );
        err.status = 409;
        throw err;
      }

      for (const item of itemIds) {
        const itemId = typeof item === 'string' ? item : item.id;
        const qtyToRemove = typeof item === 'object' && item.quantity ? Number(item.quantity) : null;

        if (qtyToRemove && qtyToRemove > 0) {
          const row = await tx.get("SELECT quantity FROM order_items WHERE order_id = ? AND id = ?", [id, itemId]);
          if (row && row.quantity > qtyToRemove) {
            await tx.run("UPDATE order_items SET quantity = quantity - ? WHERE order_id = ? AND id = ?", [qtyToRemove, id, itemId]);
          } else {
            await tx.run("DELETE FROM order_items WHERE order_id = ? AND id = ?", [id, itemId]);
          }
        } else {
          await tx.run("DELETE FROM order_items WHERE order_id = ? AND id = ?", [id, itemId]);
        }
      }

      const remaining = await tx.all(
        `SELECT order_items.quantity, order_items.price,
                COALESCE(categories.name, menu_items.category_name, '') AS category_name,
                COALESCE(categories.id, menu_items.category_id, '')     AS category_id,
                menu_items.category_name                                AS mi_category_name,
                menu_items.category_id                                  AS mi_category_id
         FROM order_items
         LEFT JOIN menu_items ON (order_items.menu_item_id = menu_items.id OR (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(menu_items.name))))
         LEFT JOIN categories ON menu_items.category_id = categories.id
         WHERE order_items.order_id = ?`,
        [id]
      );
      if (remaining.length === 0) {
        throw new Error("Cannot remove every item from an order — cancel the order instead if it's no longer needed.");
      }

      const totalsUpdates = recalculateOrderTotals(currentOrder, remaining);
      const orderUpdates = { ...totalsUpdates, updated_at: now };

      const clauses = Object.keys(orderUpdates).map((key) => `${key} = ?`).join(", ");
      const params = [...Object.values(orderUpdates), id];
      await tx.run(`UPDATE orders SET ${clauses} WHERE id = ?`, params);
      await tx.run(`DELETE FROM order_bill_splits WHERE order_id = ?`, [id]);
    });

    const items = await db.all(
      `SELECT order_items.*,
              COALESCE(categories.name, menu_items.category_name, '') AS category_name,
              COALESCE(categories.id, menu_items.category_id, '')     AS category_id,
              menu_items.category_name                                AS mi_category_name,
              menu_items.category_id                                  AS mi_category_id
       FROM order_items
       LEFT JOIN menu_items ON (order_items.menu_item_id = menu_items.id OR (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(menu_items.name))))
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ?
       ORDER BY order_items.created_at ASC`,
      [id]
    );
    const updatedOrderRow = await db.get("SELECT * FROM orders WHERE id = ?", [id]);

    return {
      id,
      waiterId: updatedOrderRow.waiter_id,
      waiterName: updatedOrderRow.waiter_name,
      total: Number(updatedOrderRow.total || 0),
      description: updatedOrderRow.description || "",
      finalTotal:
        updatedOrderRow.final_total !== null && updatedOrderRow.final_total !== undefined
          ? Number(updatedOrderRow.final_total)
          : updatedOrderRow.final_total,
      items: items.map((item) => ({
        id: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        category: item.category_name || item.mi_category_name || "",
        categoryId: item.category_id || item.mi_category_id || "",
        quantity: Number(item.quantity || 0),
        price: Number(item.price || 0),
        specialInstructions: item.special_instructions || "",
      })),
    };
  }

  const docRef2 = ordersCollection(db).doc(id);
  const snapshot2 = await docRef2.get();
  if (!snapshot2.exists) throw new Error("Order not found");
  const currentData2 = snapshot2.data();
  const currentItems2 = Array.isArray(currentData2.items) ? currentData2.items : [];

  const idSet = new Set();
  const qtyMap = {};
  for (const item of itemIds) {
    const itemId = typeof item === 'string' ? item : item.id;
    idSet.add(String(itemId));
    if (typeof item === 'object' && item.quantity) {
      qtyMap[String(itemId)] = Number(item.quantity);
    }
  }

  const remainingItems = [];
  currentItems2.forEach((item, index) => {
    const itemKey = item.id !== undefined ? String(item.id) : String(index);
    if (idSet.has(itemKey)) {
      const removeQty = qtyMap[itemKey];
      if (removeQty && removeQty > 0 && Number(item.quantity) > removeQty) {
        remainingItems.push({ ...item, quantity: Number(item.quantity) - removeQty });
      }
    } else {
      remainingItems.push(item);
    }
  });

  if (remainingItems.length === 0) {
    throw new Error("Cannot remove every item from an order \u2014 cancel the order instead if it's no longer needed.");
  }

  const newTotal2 = remainingItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);

  const updates2 = { items: remainingItems, total: newTotal2 };
  if (currentData2.discountAmount) {
    updates2.finalTotal = Math.max(0, newTotal2 - Number(currentData2.discountAmount));
  }

  await docRef2.update(updates2);
  return { id, ...updates2 };
}

export async function updateOrderItemPrices(db, id, updates) {
  if (!id) throw new Error("Order ID is required");
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("At least one update is required");
  }

  if (isSqliteDb(db)) {
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      let currentOrder;
      try {
        currentOrder = await tx.get("SELECT * FROM orders WHERE id = ? FOR UPDATE", [id]);
      } catch {
        currentOrder = await tx.get("SELECT * FROM orders WHERE id = ?", [id]);
      }
      if (!currentOrder) throw new Error("Order not found");

      // Phase 3: Reject price mutations after bill finalization.
      if (currentOrder.status === "Bill Requested") {
        const err = new Error(
          `Order ${currentOrder.order_number || id} has been finalized ('Bill Requested'). ` +
          `Item prices cannot be changed after bill finalization.`
        );
        err.status = 409;
        throw err;
      }

      for (const update of updates) {
        if (!update.id || update.newPrice === undefined) continue;
        await tx.run(
          "UPDATE order_items SET price = ?, updated_at = ? WHERE id = ? AND order_id = ?",
          [Number(update.newPrice), now, update.id, id]
        );
      }

      const allItems = await tx.all(
        `SELECT order_items.quantity, order_items.price,
                COALESCE(categories.name, menu_items.category_name, '') AS category_name,
                COALESCE(categories.id, menu_items.category_id, '')     AS category_id,
                menu_items.category_name                                AS mi_category_name,
                menu_items.category_id                                  AS mi_category_id
         FROM order_items
         LEFT JOIN menu_items ON (order_items.menu_item_id = menu_items.id OR (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(menu_items.name))))
         LEFT JOIN categories ON menu_items.category_id = categories.id
         WHERE order_items.order_id = ?`,
        [id]
      );
      const totalsUpdates = recalculateOrderTotals(currentOrder, allItems);
      const orderUpdates = { ...totalsUpdates, updated_at: now };

      const clauses = Object.keys(orderUpdates).map((key) => `${key} = ?`).join(", ");
      const params = [...Object.values(orderUpdates), id];
      await tx.run(`UPDATE orders SET ${clauses} WHERE id = ?`, params);
      await tx.run(`DELETE FROM order_bill_splits WHERE order_id = ?`, [id]);
    });

    const items = await db.all(
      `SELECT order_items.*,
              COALESCE(categories.name, menu_items.category_name, '') AS category_name,
              COALESCE(categories.id, menu_items.category_id, '')     AS category_id,
              menu_items.category_name                                AS mi_category_name,
              menu_items.category_id                                  AS mi_category_id
       FROM order_items
       LEFT JOIN menu_items ON (order_items.menu_item_id = menu_items.id OR (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(menu_items.name))))
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ?
       ORDER BY order_items.created_at ASC`,
      [id]
    );
    const updatedOrderRow = await db.get("SELECT * FROM orders WHERE id = ?", [id]);

    return {
      id,
      total: Number(updatedOrderRow.total || 0),
      description: updatedOrderRow.description || "",
      finalTotal:
        updatedOrderRow.final_total !== null && updatedOrderRow.final_total !== undefined
          ? Number(updatedOrderRow.final_total)
          : updatedOrderRow.final_total,
      items: items.map((item) => ({
        id: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        category: item.category_name || item.mi_category_name || "",
        categoryId: item.category_id || item.mi_category_id || "",
        quantity: Number(item.quantity || 0),
        price: Number(item.price || 0),
        specialInstructions: item.special_instructions || "",
      })),
    };
  }

  // Firestore
  const docRef = ordersCollection(db).doc(id);
  const snapshot = await docRef.get();
  if (!snapshot.exists) throw new Error("Order not found");

  const currentData = snapshot.data();
  const currentItems = Array.isArray(currentData.items) ? currentData.items : [];

  const updateMap = new Map();
  for (const update of updates) {
    if (update.id && update.newPrice !== undefined) {
      updateMap.set(String(update.id), Number(update.newPrice));
    }
  }

  const newItems = currentItems.map((item, index) => {
    const itemKey = item.id !== undefined ? String(item.id) : String(index);
    if (updateMap.has(itemKey)) {
      return { ...item, price: updateMap.get(itemKey) };
    }
    return item;
  });

  const newTotal = newItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);

  const resultUpdates = { items: newItems, total: newTotal };
  if (currentData.discountAmount !== null && currentData.discountAmount !== undefined) {
    resultUpdates.finalTotal = Math.max(0, newTotal - Number(currentData.discountAmount));
  }

  await docRef.update(resultUpdates);
  return { id, ...resultUpdates };
}

/**
 * Cancels (permanently deletes) a single order. Used by the red "Cancel"
 * button on the Admin "View Details" drawer and the Waiter "My Orders" card.
 * Removing the order row (and its items) makes it disappear from every
 * screen that reads the orders list — Admin Orders, Waiter dashboard,
 * Kitchen, and KOT — since they all read the same underlying data.
 * If the order was holding a table, the table is freed the same way
 * endSession() frees it.
 */
export async function deleteOrder(db, id) {
  if (!id) throw new Error("Order ID is required");

  if (isSqliteDb(db)) {
    const order = await db.get("SELECT * FROM orders WHERE id = ?", [id]);
    if (!order) return { id };

    // Soft-archive order so it clears from screen views but is preserved in reports
    await db.run("UPDATE orders SET archived = 1 WHERE id = ?", [id]);

    if (order.table_id) {
      await db.run(
        "UPDATE tables SET occupied = 0, status = 'available', current_order_id = '', current_session_id = '', updated_at = ?",
        [new Date().toISOString()]
      );
      invalidateTableCache();
    }

    return { id };
  }

  const docRef = ordersCollection(db).doc(id);
  const snapshot = await docRef.get();
  if (!snapshot.exists) return { id };
  await docRef.update({ archived: 1 });

  if (order.tableId) {
    await tablesCollection(db)
      .doc(order.tableId)
      .set({ occupied: false, status: "available", currentOrderId: "", currentSessionId: "" }, { merge: true });
    invalidateTableCache();
  }

  return { id };
}

export async function generateOrderNumber(db) {
  if (isSqliteDb(db)) {
    // Use MAX() to avoid race conditions when concurrent orders are placed
    const row = await db.get("SELECT MAX(CAST(REPLACE(order_number, 'RC-', '') AS UNSIGNED)) AS last_num FROM orders WHERE order_number LIKE 'RC-%'");
    const lastNumber = row?.last_num ?? 0;
    return `RC-${String(lastNumber + 1).padStart(4, "0")}`;
  }

  const snapshot = await db
    .collection("restaurants")
    .doc("rustic-charm")
    .collection("orders")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (snapshot.empty) {
    return "RC-0001";
  }

  const lastOrder = snapshot.docs[0].data();
  const lastNumber = parseInt((lastOrder.orderNumber || "RC-0000").replace("RC-", ""), 10);
  return `RC-${String(lastNumber + 1).padStart(4, "0")}`;
}

export async function getWaiters(db) {
  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM waiters ORDER BY created_at DESC");
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pin: row.pin,
      active: toBoolean(row.active),
      online: toBoolean(row.online),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  const snapshot = await waitersCollection(db).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function getWaiterCalls(db) {
  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM waiter_calls ORDER BY created_at DESC");
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      tableId: row.table_id,
      tableReference: row.table_reference,
      orderId: row.order_id,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  const snapshot = await waiterCallsCollection(db).orderBy("createdAt", "desc").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function addWaiter(db, waiter) {
  if (isSqliteDb(db)) {
    const id = waiter.id || crypto.randomUUID();
    const data = {
      id,
      name: waiter.name || "",
      pin: waiter.pin ?? null,
      active: waiter.active === false ? 0 : 1,
      online: waiter.online ? 1 : 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await db.run("INSERT INTO waiters (id, name, pin, active, online, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [data.id, data.name, data.pin, data.active, data.online, data.created_at, data.updated_at]);
    return { id: data.id, name: data.name, pin: data.pin, active: toBoolean(data.active), online: toBoolean(data.online) };
  }
  const docRef = await waitersCollection(db).add(waiter);
  return { id: docRef.id, ...waiter };
}

export async function updateWaiter(db, id, waiter) {
  if (!id) throw new Error("Waiter ID is required");
  if (isSqliteDb(db)) {
    const entries = Object.entries({
      name: waiter.name,
      pin: waiter.pin,
      active: waiter.active === undefined ? undefined : waiter.active ? 1 : 0,
      online: waiter.online === undefined ? undefined : waiter.online ? 1 : 0,
      updated_at: new Date().toISOString(),
    }).filter(([, value]) => value !== undefined);
    if (!entries.length) return { id, ...waiter };
    const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
    const params = entries.map(([, value]) => value);
    params.push(id);
    await db.run(`UPDATE waiters SET ${clauses} WHERE id = ?`, params);
    return { id, ...waiter };
  }
  await waitersCollection(db).doc(id).update(waiter);
  return { id, ...waiter };
}

export async function deleteWaiter(db, id) {
  if (!id) throw new Error("Waiter ID is required");
  if (isSqliteDb(db)) {
    await db.run("DELETE FROM waiters WHERE id = ?", [id]);
    return { id };
  }
  await waitersCollection(db).doc(id).delete();
  return { id };
}

export async function getKitchenCredentials(db) {
  if (isSqliteDb(db)) {
    const row = await db.get("SELECT * FROM kitchen_credentials WHERE id = 'kitchen' LIMIT 1");
    if (!row) return { id: "kitchen", password: "0000" };
    return { id: row.id || "kitchen", password: row.password || "0000" };
  }
  throw new Error("SQLite-backed backend requires SQLite database access");
}

export async function updateKitchenPassword(db, password) {
  if (!password) throw new Error("New kitchen password is required");
  if (!isSqliteDb(db)) {
    throw new Error("SQLite-backed backend requires SQLite database access");
  }
  await db.run(
    "INSERT INTO kitchen_credentials (id, password, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password), updated_at = VALUES(updated_at)",
    ["kitchen", password, new Date().toISOString()]
  );
  return { id: "kitchen", password };
}

export async function incrementMenuVersion(db) {
  if (!isSqliteDb(db)) {
    throw new Error("SQLite-backed backend requires SQLite database access");
  }
  const existing = await db.get("SELECT value FROM restaurant_settings WHERE `key` = 'menu_version' LIMIT 1");
  const nextValue = existing && existing.value ? Number(existing.value) + 1 : 1;
  await db.run(
    "INSERT INTO restaurant_settings (id, `key`, value, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
    [`menu-version-${Date.now()}`, "menu_version", String(nextValue), new Date().toISOString()]
  );
  // Update in-memory menu version monotonically after successful DB commit
  setCurrentMenuVersion(nextValue);
  // Invalidate in-memory menu cache for all languages
  invalidateMenuCache();
  return nextValue;
}

export async function getMenuVersion(db) {
  const cached = getCurrentMenuVersion();
  if (cached !== null && cached !== undefined) {
    return cached;
  }
  if (!isSqliteDb(db)) {
    throw new Error("SQLite-backed backend requires SQLite database access");
  }
  return await initMenuVersion(db);
}


export async function saveOrderSplits(db, orderId, splits) {
  if (!orderId) throw new Error("Order ID is required");
  if (isSqliteDb(db)) {
    await db.transaction(async (tx) => {
      await tx.run("DELETE FROM order_bill_splits WHERE order_id = ?", [orderId]);
      const now = new Date().toISOString();
      for (const split of splits) {
        await tx.run(
          "INSERT INTO order_bill_splits (id, order_id, bill_number, items_json, subtotal, tax, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(),
            orderId,
            split.billNumber || 1,
            JSON.stringify(split.items || []),
            split.subtotal || 0,
            split.tax || 0,
            split.total || 0,
            now
          ]
        );
      }
    });
    return { orderId, splits };
  } else {
    throw new Error("Splits only supported on SQLite");
  }
}

export async function getOrderSplits(db, orderId) {
  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM order_bill_splits WHERE order_id = ? ORDER BY bill_number ASC", [orderId]);
    return rows.map(r => ({
      id: r.id,
      orderId: r.order_id,
      billNumber: r.bill_number,
      items: JSON.parse(r.items_json),
      subtotal: r.subtotal,
      tax: r.tax,
      total: r.total,
      createdAt: r.created_at
    }));
  }
  return [];
}

export async function getKotSections(db) {
  if (!isSqliteDb(db)) return {};
  const row = await db.get("SELECT value FROM restaurant_settings WHERE `key` = 'kot_sections'");
  return row && row.value ? JSON.parse(row.value) : {};
}

export async function setKotSections(db, config) {
  if (!isSqliteDb(db)) return config;
  const json = JSON.stringify(config || {});
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO restaurant_settings (id, `key`, value, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
    ["kot_sections", "kot_sections", json, now]
  );
  return config;
}

export async function getEffectiveBillSections(db) {
  if (!isSqliteDb(db)) return {};
  let billSectionsConfig = {};
  try {
    const row = await db.get("SELECT value FROM restaurant_settings WHERE `key` = 'bill_sections' OR id = 'bill_sections' LIMIT 1");
    if (row && row.value) {
      billSectionsConfig = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    }
  } catch (_) {
    billSectionsConfig = {};
  }

  // Ensure all categories default to "Food" if not assigned (as documented in Settings UI)
  try {
    const cats = await db.all("SELECT id, name FROM categories");
    if (cats && Array.isArray(cats)) {
      for (const c of cats) {
        if (billSectionsConfig[c.id] === undefined) {
          billSectionsConfig[c.id] = "Food";
        }
      }
    }
  } catch (_) {}

  return billSectionsConfig;
}

export async function getBillSections(db) {
  return await getEffectiveBillSections(db);
}

export async function setBillSections(db, config) {
  if (!isSqliteDb(db)) return config;
  const json = JSON.stringify(config || {});
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO restaurant_settings (id, `key`, value, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
    ["bill_sections", "bill_sections", json, now]
  );
  return config;
}

export async function getMenuItemFeedbacks(db) {
  const rows = await db.all(
    `SELECT id, menu_item_id AS menuItemId, menu_item_name AS menuItemName, feedback, created_at AS createdAt
     FROM menu_item_feedbacks
     WHERE downloaded = 0
     ORDER BY created_at ASC`
  );
  return rows || [];
}

export async function markFeedbacksAsDownloaded(db, ids = []) {
  if (Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    await db.run(
      `UPDATE menu_item_feedbacks SET downloaded = 1 WHERE id IN (${placeholders})`,
      ids
    );
  } else {
    await db.run("UPDATE menu_item_feedbacks SET downloaded = 1 WHERE downloaded = 0");
  }
  return { success: true };
}

export async function billPreview(db, orderId) {
  if (!orderId) {
    const error = new Error("Order ID is required");
    error.status = 400;
    throw error;
  }

  const runInTx = typeof db.transaction === "function" ? (cb) => db.transaction(cb) : (cb) => cb(db);

  return await runInTx(async (tx) => {
    const order = await tx.get("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!order) {
      const error = new Error("Order not found");
      error.status = 404;
      throw error;
    }

    if (order.frozen_bill_json) {
      try {
        const parsed = typeof order.frozen_bill_json === "string"
          ? JSON.parse(order.frozen_bill_json)
          : order.frozen_bill_json;
        if (parsed && typeof parsed === "object" && parsed.finalTotal !== undefined) {
          return parsed;
        }
      } catch (_) {
        // Fall back to live calculation if corrupted
      }
    }

    const rawItems = await tx.all(
      `SELECT oi.id, oi.menu_item_id, oi.name, oi.quantity, oi.price,
              COALESCE(c.name, mi.category_name, '') AS category_name,
              COALESCE(c.id, mi.category_id, '')     AS category_id,
              mi.category_name                       AS mi_category_name,
              mi.category_id                         AS mi_category_id
       FROM order_items oi
       LEFT JOIN menu_items mi ON (oi.menu_item_id = mi.id OR (oi.menu_item_id IS NULL AND LOWER(TRIM(oi.name)) = LOWER(TRIM(mi.name))))
       LEFT JOIN categories  c  ON mi.category_id  = c.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at ASC`,
      [orderId]
    );

    if (!rawItems || rawItems.length === 0) {
      const error = new Error("Cannot generate bill preview for an order with no items");
      error.status = 400;
      error.code = "no_items";
      throw error;
    }

    const items = rawItems.map((row) => ({
      id: row.id,
      menuItemId: row.menu_item_id || "",
      name: row.name || "",
      quantity: Number(row.quantity || 0),
      price: Number(row.price || 0),
      category: row.category_name || row.mi_category_name || "",
      categoryId: row.category_id || row.mi_category_id || "",
    }));

    const billSectionsConfig = await getEffectiveBillSections(tx);

    const normalizedOrder = {
      id: order.id,
      orderNumber: order.order_number,
      tableLabel: order.table_label,
      tableNumber: order.table_number,
      tableReference: order.table_reference,
      waiterName: order.waiter_name,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      discountMode: order.discount_mode,
      discountType: order.discount_type,
      discountValue: order.discount_value,
      discountAmount: order.discount_amount !== null && order.discount_amount !== undefined
        ? Number(order.discount_amount)
        : null,
      foodDiscountPercent: order.food_discount_percent !== null && order.food_discount_percent !== undefined
        ? Number(order.food_discount_percent)
        : null,
      alcoholDiscountPercent: order.alcohol_discount_percent !== null && order.alcohol_discount_percent !== undefined
        ? Number(order.alcohol_discount_percent)
        : null,
    };

    try {
      return calculateAuthoritativeBill(normalizedOrder, items, billSectionsConfig);
    } catch (calcErr) {
      calcErr.status = 400;
      throw calcErr;
    }
  });
}

/**
 * Self-heals any menu_items that have category_id NULL or empty by resolving against categories.
 */
export async function healUnlinkedMenuItems(db) {
  if (!isSqliteDb(db)) return;
  try {
    const unlinked = await db.all(
      "SELECT id, name, category_name FROM menu_items WHERE category_id IS NULL OR category_id = '' LIMIT 200"
    );
    if (!unlinked || unlinked.length === 0) return;

    for (const item of unlinked) {
      const catInfo = await resolveCategoryInfo(db, item.category_name || item.name);
      if (catInfo && catInfo.id) {
        await db.run("UPDATE menu_items SET category_id = ? WHERE id = ?", [catInfo.id, item.id]);
      }
    }
  } catch (e) {
    console.warn("[healUnlinkedMenuItems] Warning during self-healing:", e.message);
  }
}

export { invalidateMenuCache, initMenuVersion, getCurrentMenuVersion };

