import crypto from "crypto";
import { getSqliteDb } from "../config/database.js";

const sqlite = {
  async all(sql, params = []) {
    const db = getSqliteDb();
    const result = db.all(sql, params);
    if (result && typeof result.then === "function") {
      return result;
    }
    return new Promise((resolve, reject) => {
      db.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(rows || []);
      });
    });
  },

  async run(sql, params = []) {
    const db = getSqliteDb();
    const result = db.run(sql, params);
    if (result && typeof result.then === "function") {
      return result;
    }
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(error) {
        if (error) {
          reject(error);
          return;
        }
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  },
};

const toBoolean = (value) => value === 1 || value === true || value === "1";

const normalizeCategory = (row) => ({
  id: row.id,
  name: row.name,
  isActive: toBoolean(row.is_active),
  displayOrder: Number(row.display_order || 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const normalizeMenuItem = (row) => ({
  id: row.id,
  categoryId: row.category_id,
  name: row.name,
  description: row.description || "",
  price: Number(row.price || 0),
  imageUrl: row.image_url || "",
  isVeg: toBoolean(row.is_veg),
  isAvailable: toBoolean(row.is_available),
  isPopular: toBoolean(row.is_popular),
  prepTime: row.prep_time ?? null,
  rating: Number(row.rating || 0),
  metadata: row.metadata ? JSON.parse(row.metadata) : {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const normalizeTable = (row) => ({
  id: row.id,
  tableKey: row.table_key,
  tableNumber: Number(row.table_number),
  area: row.area,
  areaLabel: row.area_label || row.area,
  displayName: row.display_name || `${row.area_label || row.area} - Table ${row.table_number}`,
  occupied: toBoolean(row.occupied),
  status: row.status || "available",
  currentOrderId: row.current_order_id || "",
  currentSessionId: row.current_session_id || "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function getCategoriesFromDb() {
  const rows = await sqlite.all(
    "SELECT * FROM categories ORDER BY display_order ASC, created_at DESC"
  );
  return rows.map(normalizeCategory);
}

export async function addCategoryToDb(category) {
  const id = category.id || crypto.randomUUID();
  const data = {
    id,
    name: category.name || "",
    is_active: category.isActive === false ? 0 : 1,
    display_order: Number(category.displayOrder ?? 0),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await sqlite.run(
    "INSERT INTO categories (id, name, is_active, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [data.id, data.name, data.is_active, data.display_order, data.created_at, data.updated_at]
  );

  return normalizeCategory(data);
}

export async function updateCategoryInDb(id, category) {
  const updates = { ...category, updated_at: new Date().toISOString() };
  const entries = Object.entries({
    name: updates.name,
    is_active: updates.isActive === undefined ? undefined : updates.isActive ? 1 : 0,
    display_order: updates.displayOrder,
    updated_at: updates.updated_at,
  }).filter(([, value]) => value !== undefined);

  if (!entries.length) {
    return { id };
  }

  const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
  const params = entries.map(([, value]) => value);
  params.push(id);

  await sqlite.run(`UPDATE categories SET ${clauses} WHERE id = ?`, params);
  return { id, ...category };
}

export async function deleteCategoryFromDb(id) {
  await sqlite.run("DELETE FROM categories WHERE id = ?", [id]);
  return { id };
}

export async function getMenuItemsFromDb() {
  const rows = await sqlite.all(
    "SELECT * FROM menu_items ORDER BY created_at DESC"
  );
  return rows.map(normalizeMenuItem);
}

export async function addMenuItemToDb(item) {
  const id = item.id || crypto.randomUUID();
  const payload = {
    id,
    category_id: item.categoryId || item.category_id || null,
    name: item.name || "",
    description: item.description || "",
    price: Number(item.price || 0),
    image_url: item.imageUrl || item.image_url || "",
    is_veg: item.isVeg === false ? 0 : 1,
    is_available: item.isAvailable === false ? 0 : 1,
    is_popular: item.isPopular ? 1 : 0,
    prep_time: item.prepTime ?? null,
    rating: Number(item.rating || 0),
    metadata: item.metadata ? JSON.stringify(item.metadata) : JSON.stringify({}),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await sqlite.run(
    "INSERT INTO menu_items (id, category_id, name, description, price, image_url, is_veg, is_available, is_popular, prep_time, rating, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [payload.id, payload.category_id, payload.name, payload.description, payload.price, payload.image_url, payload.is_veg, payload.is_available, payload.is_popular, payload.prep_time, payload.rating, payload.metadata, payload.created_at, payload.updated_at]
  );

  return normalizeMenuItem(payload);
}

export async function updateMenuItemInDb(id, item) {
  const updates = {
    ...item,
    updated_at: new Date().toISOString(),
  };

  const entries = Object.entries({
    category_id: updates.categoryId ?? updates.category_id,
    name: updates.name,
    description: updates.description,
    price: updates.price,
    image_url: updates.imageUrl ?? updates.image_url,
    is_veg: updates.isVeg === undefined ? undefined : updates.isVeg ? 1 : 0,
    is_available: updates.isAvailable === undefined ? undefined : updates.isAvailable ? 1 : 0,
    is_popular: updates.isPopular === undefined ? undefined : updates.isPopular ? 1 : 0,
    prep_time: updates.prepTime,
    rating: updates.rating,
    metadata: updates.metadata ? JSON.stringify(updates.metadata) : undefined,
    updated_at: updates.updated_at,
  }).filter(([, value]) => value !== undefined);

  if (!entries.length) {
    return { id, ...item };
  }

  const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
  const params = entries.map(([, value]) => value);
  params.push(id);

  await sqlite.run(`UPDATE menu_items SET ${clauses} WHERE id = ?`, params);
  return { id, ...item };
}

export async function deleteMenuItemFromDb(id) {
  await sqlite.run("DELETE FROM menu_items WHERE id = ?", [id]);
  return { id };
}

export async function getTablesFromDb() {
  const rows = await sqlite.all("SELECT * FROM tables ORDER BY table_number ASC");
  return rows.map(normalizeTable);
}

export async function createTableInDb(tableData) {
  const input = tableData || {};
  const area = String(input.area || "").trim();
  const areaLabel = input.areaLabel || input.area || "Table";
  const tableNumber = Number(input.tableNumber);
  if (!area || Number.isNaN(tableNumber)) {
    throw new Error("Table area and table number are required");
  }

  const normalizedArea = area.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "table";
  const tableKey = `${normalizedArea}-${tableNumber}`;
  const id = input.id || tableKey;
  const row = {
    id,
    table_key: tableKey,
    table_number: tableNumber,
    area: normalizedArea,
    area_label: areaLabel,
    display_name: input.displayName || `${areaLabel} - Table ${tableNumber}`,
    occupied: input.occupied ? 1 : 0,
    status: input.status || "available",
    current_order_id: input.currentOrderId || "",
    current_session_id: input.currentSessionId || "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await sqlite.run(
    "INSERT INTO tables (id, table_key, table_number, area, area_label, display_name, occupied, status, current_order_id, current_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.table_key, row.table_number, row.area, row.area_label, row.display_name, row.occupied, row.status, row.current_order_id, row.current_session_id, row.created_at, row.updated_at]
  );

  return normalizeTable(row);
}

export async function updateTableInDb(id, updates) {
  const entry = { ...updates, updated_at: new Date().toISOString() };
  const entries = Object.entries({
    table_key: entry.tableKey,
    table_number: entry.tableNumber,
    area: entry.area,
    area_label: entry.areaLabel,
    display_name: entry.displayName,
    occupied: entry.occupied === undefined ? undefined : entry.occupied ? 1 : 0,
    status: entry.status,
    current_order_id: entry.currentOrderId,
    current_session_id: entry.currentSessionId,
    updated_at: entry.updated_at,
  }).filter(([, value]) => value !== undefined);

  if (!entries.length) {
    return { id, ...updates };
  }

  const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
  const params = entries.map(([, value]) => value);
  params.push(id);

  await sqlite.run(`UPDATE tables SET ${clauses} WHERE id = ?`, params);
  return { id, ...updates };
}

export async function incrementMenuVersionInDb() {
  const current = await sqlite.all("SELECT value FROM restaurant_settings WHERE `key` = 'menu_version' LIMIT 1");
  const nextValue = current.length ? Number(current[0].value || 0) + 1 : 1;
  await sqlite.run(
    "INSERT INTO restaurant_settings (id, `key`, value, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
    [`menu-version`, "menu_version", String(nextValue), new Date().toISOString()]
  );
  return nextValue;
}
