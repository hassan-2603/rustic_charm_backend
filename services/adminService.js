import crypto from "crypto";

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
  if (typeof value === "object") return JSON.stringify(value);
  return value ?? "";
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
    // Try by exact id first
    const byId = await db.get("SELECT id, name FROM categories WHERE id = ? LIMIT 1", [lookupName]);
    if (byId?.id) return { id: byId.id, name: byId.name };

    // Try by name (case-insensitive)
    const byName = await db.get(
      "SELECT id, name FROM categories WHERE LOWER(name) = LOWER(?) LIMIT 1",
      [lookupName]
    );
    if (byName?.id) return { id: byName.id, name: byName.name };

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
      name: category.name || "",
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
    name: category.name || "",
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
      name: category.name,
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

export async function getMenuItems(db) {
  if (isSqliteDb(db)) {
    const rows = await db.all(
      `SELECT menu_items.*, categories.name AS cat_join_name
       FROM menu_items
       LEFT JOIN categories ON menu_items.category_id = categories.id
       ORDER BY menu_items.created_at DESC`
    );

    // Fetch all translations for all menu items
    const translationsRows = await db.all(
      `SELECT menu_item_id, language_code, name, description FROM menu_translations`
    );

    // Build a map of translations: menu_item_id -> { language_code -> { name, description } }
    const translationsMap = {};
    for (const trans of translationsRows) {
      if (!translationsMap[trans.menu_item_id]) {
        translationsMap[trans.menu_item_id] = {};
      }
      translationsMap[trans.menu_item_id][trans.language_code] = {
        name: trans.name,
        description: trans.description,
      };
    }

    return rows.map((row) => ({
      id: row.id,
      categoryId: row.category_id,
      // Use the JOIN name first, then the stored fallback name, then the id, then empty
      category: row.cat_join_name || row.category_name || row.category_id || "",
      name: parseJsonField(row.name),
      description: parseJsonField(row.description) || "",
      price: Number(row.price || 0),
      imageUrl: row.image_url || "",
      image: row.image_url || "",
      isVeg: toBoolean(row.is_veg),
      isAvailable: toBoolean(row.is_available),
      isPopular: toBoolean(row.is_popular),
      prepTime: row.prep_time,
      rating: Number(row.rating || 0),
      metadata: row.metadata ? parseJsonField(row.metadata) : {},
      priceOptions: row.metadata ? parseJsonField(row.metadata).priceOptions : undefined,
      translations: translationsMap[row.id] || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  const snapshot = await menuCollection(db).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM tables ORDER BY table_number ASC");
    return rows.map((row) => ({
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
    }));
  }
  const snapshot = await tablesCollection(db).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
    return { id, ...updates };
  }
  await tablesCollection(db).doc(id).update(updates);
  return { id, ...updates };
}

export async function deleteTable(db, id) {
  if (!id) throw new Error("Table ID is required");
  if (isSqliteDb(db)) {
    await db.run("DELETE FROM tables WHERE id = ?", [id]);
    return { id };
  }
  await tablesCollection(db).doc(id).delete();
  return { id };
}

export async function getOrders(db) {
  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM orders ORDER BY created_at DESC");
    const orders = [];
    for (const row of rows) {
      const items = await db.all(
        `SELECT order_items.*, categories.name AS category_name
         FROM order_items
         LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
         LEFT JOIN categories ON menu_items.category_id = categories.id
         WHERE order_items.order_id = ?
         ORDER BY order_items.created_at ASC`,
        [row.id]
      );
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
        waiterName: row.waiter_name,
        acceptedAt: row.accepted_at,
        servedAt: row.served_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        items: items.map((item) => ({
          id: item.id,
          menuItemId: item.menu_item_id,
          name: item.name,
          category: item.category_name || "",
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
  const id = crypto.randomUUID();
  const orderNumber = await generateOrderNumber(db);
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO orders (id, table_id, table_reference, table_number, table_area, table_label, order_number, order_source, status, total, waiter_id, waiter_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, table.id, table.table_key, table.table_number, table.area, table.display_name, orderNumber, "admin", "Accepted", Number(order.total) || 0, waiter.id, waiter.name, now, now]
  );
  for (const item of order.items) {
    await db.run(
      "INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, price, special_instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), id, item.menuItemId || null, item.name || "", Math.max(1, Number(item.quantity) || 1), Number(item.price) || 0, "", now]
    );
  }
  await db.run("UPDATE tables SET occupied = 1, status = 'occupied', current_order_id = ?, updated_at = ? WHERE id = ?", [id, now, table.id]);
  return { id, orderNumber };
}

export async function deleteAllOrders(db) {
  if (isSqliteDb(db)) {
    const result = await db.run("DELETE FROM orders");
    await db.run("VACUUM");
    return { count: result.changes };
  }
  const snapshot = await ordersCollection(db).get();
  const deletes = snapshot.docs.map((doc) => ordersCollection(db).doc(doc.id).delete());
  await Promise.all(deletes);
  return { count: deletes.length };
}

export async function deleteAllCompletedOrders(db) {
  if (isSqliteDb(db)) {
    const result = await db.run("DELETE FROM orders WHERE status = 'Completed'");
    await db.run("VACUUM");
    return { count: result.changes };
  }
  const snapshot = await ordersCollection(db).get();
  const deletes = snapshot.docs
    .filter((doc) => doc.data().status === "Completed")
    .map((doc) => ordersCollection(db).doc(doc.id).delete());
  await Promise.all(deletes);
  return { count: deletes.length };
}

export async function updateOrder(db, id, updates) {
  if (!id) throw new Error("Order ID is required");
  if (isSqliteDb(db)) {
    const currentOrder = await db.get("SELECT * FROM orders WHERE id = ?", [id]);
    if (!currentOrder) throw new Error("Order not found");

    const now = new Date().toISOString();
    let table;
    if (updates.tableId !== undefined) {
      table = await db.get("SELECT * FROM tables WHERE id = ?", [updates.tableId]);
      if (!table) throw new Error("Selected table was not found");
      if (table.id !== currentOrder.table_id && table.occupied && table.current_order_id && table.current_order_id !== id) {
        throw new Error("Selected table is occupied");
      }
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
      discount_type: updates.discountType,
      discount_value: updates.discountValue,
      discount_amount: updates.discountAmount,
      final_total: updates.finalTotal,
      discount_mode: updates.discountMode,
      food_discount_percent: updates.foodDiscountPercent,
      alcohol_discount_percent: updates.alcoholDiscountPercent,
      food_discount_amount: updates.foodDiscountAmount,
      alcohol_discount_amount: updates.alcoholDiscountAmount,
      waiter_id: updates.waiterId,
      waiter_name: updates.waiterName,
      accepted_at: updates.acceptedAt,
      served_at: updates.servedAt,
      completed_at: updates.completedAt,
      updated_at: now,
    };
    const entries = Object.entries(orderUpdates).filter(([, value]) => value !== undefined);
    if (!entries.length) return { id, ...updates };

    await db.run("BEGIN TRANSACTION");
    try {
      const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
      const params = entries.map(([, value]) => value);
      params.push(id);
      await db.run(`UPDATE orders SET ${clauses} WHERE id = ?`, params);

      if (table && table.id !== currentOrder.table_id) {
        const oldTableParams = [now, currentOrder.table_id, id];
        if (currentOrder.session_id) oldTableParams.push(currentOrder.session_id);
        await db.run(
          `UPDATE tables SET occupied = 0, status = 'available', current_order_id = '', current_session_id = '', updated_at = ? WHERE id = ? AND (current_order_id = ?${currentOrder.session_id ? " OR current_session_id = ?" : ""})`,
          oldTableParams
        );
        await db.run(
          "UPDATE tables SET occupied = 1, status = 'occupied', current_order_id = ?, current_session_id = ?, updated_at = ? WHERE id = ?",
          [id, currentOrder.session_id || "", now, table.id]
        );

        if (currentOrder.session_id) {
          await db.run(
            "UPDATE sessions SET table_id = ?, table_reference = ?, updated_at = ? WHERE id = ?",
            [table.id, table.table_key, now, currentOrder.session_id]
          );
          await db.run(
            "UPDATE orders SET table_id = ?, table_reference = ?, table_number = ?, table_area = ?, table_label = ?, updated_at = ? WHERE session_id = ?",
            [table.id, table.table_key, table.table_number, table.area, table.display_name, now, currentOrder.session_id]
          );
        }
      }

      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK");
      throw error;
    }
    return { id, ...updates, ...(table ? { tableId: table.id, tableReference: table.table_key, tableNumber: table.table_number, tableArea: table.area, tableLabel: table.display_name } : {}) };
  }
  await ordersCollection(db).doc(id).update(updates);
  return { id, ...updates };
}

/**
 * Adds one or more items to an existing order (used by the "Add Item" flow
 * on both the Admin "View Details" drawer and the Waiter "My Orders" card).
 * This only inserts additional order_items / appends to the items array and
 * recalculates the order total — it never touches any other order field.
 * If the order already has a discount amount applied, finalTotal is kept in
 * sync (same discountAmount, recomputed against the new total).
 */
export async function addOrderItems(db, id, itemsToAdd) {
  if (!id) throw new Error("Order ID is required");
  if (!Array.isArray(itemsToAdd) || itemsToAdd.length === 0) {
    throw new Error("At least one item is required");
  }

  if (isSqliteDb(db)) {
    const currentOrder = await db.get("SELECT * FROM orders WHERE id = ?", [id]);
    if (!currentOrder) throw new Error("Order not found");

    const now = new Date().toISOString();

    await db.run("BEGIN TRANSACTION");
    try {
      for (const item of itemsToAdd) {
        await db.run(
          "INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, price, special_instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            crypto.randomUUID(),
            id,
            item.menuItemId || null,
            item.name || "",
            Math.max(1, Number(item.quantity) || 1),
            Number(item.price) || 0,
            "",
            now,
          ]
        );
      }

      const allItems = await db.all("SELECT quantity, price FROM order_items WHERE order_id = ?", [id]);
      const newTotal = allItems.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.quantity || 0), 0);

      const orderUpdates = { total: newTotal, updated_at: now };
      if (currentOrder.discount_amount) {
        orderUpdates.final_total = Math.max(0, newTotal - Number(currentOrder.discount_amount));
      }

      const clauses = Object.keys(orderUpdates).map((key) => `${key} = ?`).join(", ");
      const params = [...Object.values(orderUpdates), id];
      await db.run(`UPDATE orders SET ${clauses} WHERE id = ?`, params);

      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK");
      throw error;
    }

    const items = await db.all(
      `SELECT order_items.*, categories.name AS category_name
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ?
       ORDER BY order_items.created_at ASC`,
      [id]
    );
    const updatedOrderRow = await db.get("SELECT * FROM orders WHERE id = ?", [id]);

    return {
      id,
      total: Number(updatedOrderRow.total || 0),
      finalTotal:
        updatedOrderRow.final_total !== null && updatedOrderRow.final_total !== undefined
          ? Number(updatedOrderRow.final_total)
          : updatedOrderRow.final_total,
      items: items.map((item) => ({
        id: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        category: item.category_name || "",
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
    const currentOrder = await db.get("SELECT * FROM orders WHERE id = ?", [id]);
    if (!currentOrder) throw new Error("Order not found");

    const now = new Date().toISOString();

    await db.run("BEGIN TRANSACTION");
    try {
      const placeholders = itemIds.map(() => "?").join(", ");
      await db.run(
        `DELETE FROM order_items WHERE order_id = ? AND id IN (${placeholders})`,
        [id, ...itemIds]
      );

      const remaining = await db.all("SELECT quantity, price FROM order_items WHERE order_id = ?", [id]);
      if (remaining.length === 0) {
        throw new Error("Cannot remove every item from an order \u2014 cancel the order instead if it's no longer needed.");
      }

      const newTotal = remaining.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.quantity || 0), 0);

      const orderUpdates = { total: newTotal, updated_at: now };
      if (currentOrder.discount_amount) {
        orderUpdates.final_total = Math.max(0, newTotal - Number(currentOrder.discount_amount));
      }

      const clauses = Object.keys(orderUpdates).map((key) => `${key} = ?`).join(", ");
      const params = [...Object.values(orderUpdates), id];
      await db.run(`UPDATE orders SET ${clauses} WHERE id = ?`, params);

      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK");
      throw error;
    }

    const items = await db.all(
      `SELECT order_items.*, categories.name AS category_name
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ?
       ORDER BY order_items.created_at ASC`,
      [id]
    );
    const updatedOrderRow = await db.get("SELECT * FROM orders WHERE id = ?", [id]);

    return {
      id,
      total: Number(updatedOrderRow.total || 0),
      finalTotal:
        updatedOrderRow.final_total !== null && updatedOrderRow.final_total !== undefined
          ? Number(updatedOrderRow.final_total)
          : updatedOrderRow.final_total,
      items: items.map((item) => ({
        id: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        category: item.category_name || "",
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

  const idSet = new Set(itemIds.map(String));
  const remainingItems = currentItems2.filter((item, index) => {
    const itemKey = item.id !== undefined ? String(item.id) : String(index);
    return !idSet.has(itemKey);
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

    await db.run("DELETE FROM order_items WHERE order_id = ?", [id]);
    await db.run("DELETE FROM orders WHERE id = ?", [id]);

    if (order.table_id) {
      await db.run(
        "UPDATE tables SET occupied = 0, status = 'available', current_order_id = '', current_session_id = '', updated_at = ? WHERE id = ? AND current_order_id = ?",
        [new Date().toISOString(), order.table_id, id]
      );
    }

    return { id };
  }

  const docRef = ordersCollection(db).doc(id);
  const snapshot = await docRef.get();
  if (!snapshot.exists) return { id };
  const order = snapshot.data();
  await docRef.delete();

  if (order.tableId) {
    await tablesCollection(db)
      .doc(order.tableId)
      .set({ occupied: false, status: "available", currentOrderId: "", currentSessionId: "" }, { merge: true });
  }

  return { id };
}

export async function generateOrderNumber(db) {
  if (isSqliteDb(db)) {
    // Use MAX() to avoid race conditions when concurrent orders are placed
    const row = await db.get("SELECT MAX(CAST(REPLACE(order_number, 'RC-', '') AS INTEGER)) AS last_num FROM orders WHERE order_number LIKE 'RC-%'");
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
    "INSERT INTO kitchen_credentials (id, password, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at",
    ["kitchen", password, new Date().toISOString()]
  );
  return { id: "kitchen", password };
}

export async function incrementMenuVersion(db) {
  if (!isSqliteDb(db)) {
    throw new Error("SQLite-backed backend requires SQLite database access");
  }
  const existing = await db.get("SELECT value FROM restaurant_settings WHERE key = 'menu_version' LIMIT 1");
  const nextValue = existing && existing.value ? Number(existing.value) + 1 : 1;
  await db.run(
    "INSERT INTO restaurant_settings (id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [`menu-version-${Date.now()}`, "menu_version", String(nextValue), new Date().toISOString()]
  );
  return nextValue;
}

export async function getMenuVersion(db) {
  if (!isSqliteDb(db)) {
    throw new Error("SQLite-backed backend requires SQLite database access");
  }
  const row = await db.get("SELECT value FROM restaurant_settings WHERE key = 'menu_version' LIMIT 1");
  return row && row.value ? Number(row.value) : 1;
}


export async function saveOrderSplits(db, orderId, splits) {
  if (!orderId) throw new Error("Order ID is required");
  if (isSqliteDb(db)) {
    await db.run("BEGIN TRANSACTION");
    try {
      await db.run("DELETE FROM order_bill_splits WHERE order_id = ?", [orderId]);
      const now = new Date().toISOString();
      for (const split of splits) {
        await db.run(
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
      await db.run("COMMIT");
    } catch (err) {
      await db.run("ROLLBACK");
      throw err;
    }
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
  const row = await db.get("SELECT value FROM restaurant_settings WHERE key = 'kot_sections'");
  return row && row.value ? JSON.parse(row.value) : {};
}

export async function setKotSections(db, config) {
  if (!isSqliteDb(db)) return config;
  const json = JSON.stringify(config || {});
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO restaurant_settings (id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ["kot_sections", "kot_sections", json, now]
  );
  return config;
}

export async function getBillSections(db) {
  if (!isSqliteDb(db)) return {};
  const row = await db.get("SELECT value FROM restaurant_settings WHERE key = 'bill_sections'");
  return row && row.value ? JSON.parse(row.value) : {};
}

export async function setBillSections(db, config) {
  if (!isSqliteDb(db)) return config;
  const json = JSON.stringify(config || {});
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO restaurant_settings (id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ["bill_sections", "bill_sections", json, now]
  );
  return config;
}
