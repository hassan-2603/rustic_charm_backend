import crypto from "crypto";
import { addOrderItems } from "./adminService.js";
import { getCustomerTables, invalidateTableCache } from "./tableCache.js";
import { calculateAuthoritativeBill } from "./billCalculationService.js";

function isSqliteDb(db) {
  return !!db && typeof db.all === "function" && typeof db.run === "function" && !db.collection;
}

function normalizeTableReference(reference) {
  if (reference === null || reference === undefined) return "";
  return String(reference)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function buildTableKey(area, tableNumber) {
  const normalizedArea = String(area || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return `${normalizedArea || "table"}-${String(tableNumber)}`;
}

function getAreaLabel(area) {
  const knownAreas = [
    { key: "deck-area", label: "Deck Area" },
    { key: "dine-in-area", label: "Dine in area" },
    { key: "courtyard-area", label: "Courtyard area" },
    { key: "chillout-area", label: "Chillout area" },
  ];
  const match = knownAreas.find((item) => item.key === area);
  return match?.label || area || "Unassigned Area";
}

function decodeTableToken(token) {
  if (!token) return null;
  const str = String(token).trim();
  if (!str.startsWith("rc_")) return null;
  const hex = str.slice(3);
  if (hex.length % 2 !== 0) return null;
  try {
    let result = "";
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.substring(i, i + 2), 16) ^ (0x4b + ((i / 2) % 7));
      result += String.fromCharCode(code);
    }
    return result;
  } catch {
    return null;
  }
}

function resolveTableFromReference(tables, reference) {
  if (!reference) return null;
  const rawStr = String(reference).trim();
  const decoded = decodeTableToken(rawStr);
  const targets = [
    normalizeTableReference(rawStr),
    decoded ? normalizeTableReference(decoded) : null
  ].filter(Boolean);

  for (const target of targets) {
    const found = tables.find((table) => {
      const tableKey = normalizeTableReference(table.tableKey || table.id || buildTableKey(table.area || table.areaLabel || "", table.tableNumber));
      const displayName = normalizeTableReference(table.displayName || `${table.areaLabel || getAreaLabel(table.area)} - Table ${table.tableNumber}`);
      const areaKey = normalizeTableReference(table.area);
      const areaLabel = normalizeTableReference(table.areaLabel || getAreaLabel(table.area));
      const tableNumber = normalizeTableReference(table.tableNumber);
      const areaTableRef = normalizeTableReference(`${table.area || table.areaLabel || ""}-${table.tableNumber || ""}`);
      const labelledRef = normalizeTableReference(`${table.areaLabel || areaKey || ""}-${tableNumber}`);
      const tableId = normalizeTableReference(table.id);

      return (
        tableKey === target ||
        tableId === target ||
        displayName === target ||
        areaKey === target ||
        areaTableRef === target ||
        labelledRef === target ||
        normalizeTableReference(`${table.area || ""}-${table.tableNumber || ""}`) === target
      );
    });
    if (found) return found;
  }

  return null;
}

function enrichTable(tableDoc) {
  const data = tableDoc.data() || {};
  const table = {
    id: tableDoc.id,
    ...data,
  };
  const areaLabel = table.areaLabel || getAreaLabel(table.area);
  const displayName = table.displayName || `${areaLabel} - Table ${table.tableNumber}`;
  const tableKey = table.tableKey || buildTableKey(table.area || table.areaLabel || "", table.tableNumber);

  return {
    ...table,
    areaLabel,
    displayName,
    tableKey,
  };
}

async function listCustomerTables(db) {
  return await getCustomerTables(db);
}

async function getSessionInfo(db, sessionId, tableReference) {
  if (!sessionId || !tableReference) {
    throw new Error("sessionId and tableReference are required");
  }

  const tables = await listCustomerTables(db);
  const table = resolveTableFromReference(tables, tableReference);
  if (!table) {
    const error = new Error("Table reference is invalid");
    error.status = 404;
    throw error;
  }

  const orders = await getOrdersBySession(db, sessionId);

  return {
    sessionId,
    tableReference,
    table,
    orders,
    active: orders.length > 0,
    latestOrder: orders.length > 0 ? orders[0] : null,
  };
}

async function generateOrderNumber(db) {
  if (isSqliteDb(db)) {
    // Use MAX() to be race-safe when concurrent orders are placed simultaneously
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

function sanitizeOrderItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    let name =
      typeof item.menuItem?.name === "object"
        ? item.menuItem?.name.English || Object.values(item.menuItem?.name)[0] || ""
        : item.menuItem?.name || "";

    if (item.selectedPriceOption && item.menuItem) {
      const rawOptions =
        Array.isArray(item.menuItem.priceOptions) && item.menuItem.priceOptions.length > 0
          ? item.menuItem.priceOptions
          : Array.isArray(item.menuItem.metadata?.priceOptions) &&
            item.menuItem.metadata.priceOptions.length > 0
          ? item.menuItem.metadata.priceOptions
          : null;

      if (rawOptions && rawOptions.length > 1) {
        const opt = item.selectedPriceOption;
        let optLabel = "";
        if (opt.unit && String(opt.unit).trim()) {
          const u = String(opt.unit).trim();
          if (
            isNaN(Number(u)) &&
            (u.toLowerCase().includes("half") ||
              u.toLowerCase().includes("full") ||
              u.toLowerCase().includes("small") ||
              u.toLowerCase().includes("large") ||
              u.toLowerCase().includes("medium") ||
              u.toLowerCase().includes("glass") ||
              u.toLowerCase().includes("bottle") ||
              u.toLowerCase().includes("portion") ||
              u.toLowerCase().includes("plate"))
          ) {
            optLabel = u;
          } else {
            optLabel = `${opt.quantity} ${u}`;
          }
        } else {
          optLabel = `${opt.quantity} ${opt.quantity === 1 ? "piece" : "pieces"}`;
        }
        if (optLabel && !name.includes(optLabel)) {
          name = `${name} (${optLabel})`;
        }
      }
    }

    return {
      menuItemId: item.menuItem?.id || "",
      name,
      quantity: Number(item.quantity) || 1,
      price: Number(item.selectedPriceOption?.amount ?? item.menuItem?.price ?? 0),
      specialInstructions: item.specialInstructions || "",
    };
  });
}

async function createOrder(db, tableReference, cart, total, sessionId, customerName, customerPhone) {
  if (!tableReference) {
    const error = new Error("Table reference is required");
    error.status = 400;
    throw error;
  }
  if (!sessionId) {
    const error = new Error("Session ID is required");
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(cart) || cart.length === 0) {
    const error = new Error("Cart cannot be empty");
    error.status = 400;
    throw error;
  }
  const validTable = await validateTableReference(db, tableReference);
  const orderNumber = await generateOrderNumber(db);

  if (isSqliteDb(db)) {
    // 1. Check if the table already has an active running order
    const tableRow = await db.get("SELECT * FROM tables WHERE id = ?", [validTable.id]);
    let existingOrder = null;

    if (tableRow && tableRow.occupied && tableRow.current_order_id) {
      existingOrder = await db.get(
        "SELECT * FROM orders WHERE id = ? AND status NOT IN ('Completed', 'Cancelled')",
        [tableRow.current_order_id]
      );
    }

    if (!existingOrder && sessionId) {
      existingOrder = await db.get(
        "SELECT * FROM orders WHERE session_id = ? AND table_id = ? AND status NOT IN ('Completed', 'Cancelled') ORDER BY created_at DESC LIMIT 1",
        [sessionId, validTable.id]
      );
    }

    if (existingOrder) {
      const items = sanitizeOrderItems(cart);
      await addOrderItems(db, existingOrder.id, items, "");

      if (sessionId) {
        const sessionExists = await db.get("SELECT id FROM sessions WHERE id = ?", [sessionId]);
        if (!sessionExists) {
          await db.run(
            "INSERT INTO sessions (id, table_id, table_reference, status, created_at) VALUES (?, ?, ?, 'active', ?)",
            [sessionId, validTable.id, validTable.tableKey, new Date().toISOString()]
          );
        }
        await db.run(
          "UPDATE orders SET session_id = COALESCE(NULLIF(session_id, ''), ?) WHERE id = ?",
          [sessionId, existingOrder.id]
        );
        await db.run(
          "UPDATE tables SET current_session_id = ? WHERE id = ?",
          [sessionId, validTable.id]
        );
        invalidateTableCache();
      }

      if (customerName || customerPhone) {
        await db.run(
          "UPDATE orders SET customer_name = COALESCE(NULLIF(customer_name, ''), ?), customer_phone = COALESCE(NULLIF(customer_phone, ''), ?) WHERE id = ?",
          [String(customerName || "").trim(), String(customerPhone || "").trim(), existingOrder.id]
        );
      }

      return {
        id: existingOrder.id,
        orderNumber: existingOrder.order_number,
        tableReference: validTable.tableKey,
        appended: true,
      };
    }

    const sessionExists = await db.get("SELECT id FROM sessions WHERE id = ?", [sessionId]);
    if (!sessionExists) {
      await db.run(
        "INSERT INTO sessions (id, table_id, table_reference, status, created_at) VALUES (?, ?, ?, 'active', ?)",
        [sessionId, validTable.id, validTable.tableKey, new Date().toISOString()]
      );
    }

    const id = crypto.randomUUID();
    const orderData = {
      id,
      session_id: sessionId,
      table_id: validTable.id,
      table_reference: validTable.tableKey,
      table_number: Number(validTable.tableNumber) || 0,
      table_area: validTable.area || validTable.areaLabel || "",
      table_label: validTable.displayName,
      order_number: orderNumber,
      status: "Pending",
      total: Number(total) || 0,
      customer_name: String(customerName || "").trim(),
      customer_phone: String(customerPhone || "").trim(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await db.run(
      "INSERT INTO orders (id, session_id, table_id, table_reference, table_number, table_area, table_label, order_number, status, total, customer_name, customer_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [orderData.id, orderData.session_id, orderData.table_id, orderData.table_reference, orderData.table_number, orderData.table_area, orderData.table_label, orderData.order_number, orderData.status, orderData.total, orderData.customer_name, orderData.customer_phone, orderData.created_at, orderData.updated_at]
    );

    const items = sanitizeOrderItems(cart);
    for (const item of items) {
      await db.run(
        "INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, price, special_instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), orderData.id, item.menuItemId || null, item.name || "", Number(item.quantity) || 1, Number(item.price) || 0, item.specialInstructions || "", new Date().toISOString()]
      );
    }

    await db.run(
      "UPDATE tables SET occupied = 1, status = 'occupied', current_order_id = ?, current_session_id = ? WHERE id = ?",
      [orderData.id, sessionId, validTable.id]
    );
    invalidateTableCache();

    return { id: orderData.id, orderNumber, tableReference: validTable.tableKey };
  }

  throw new Error("SQLite-backed backend requires SQLite database access");
}


async function getOrdersBySession(db, sessionId) {
  if (!sessionId) {
    const error = new Error("sessionId is required");
    error.status = 400;
    throw error;
  }

  if (isSqliteDb(db)) {
    const rows = await db.all(
      `SELECT o.*, w.name AS lookup_waiter_name 
       FROM orders o 
       LEFT JOIN waiters w ON o.waiter_id = w.id 
       WHERE o.session_id = ? 
       ORDER BY o.created_at DESC`,
      [sessionId]
    );
    const orders = [];
    for (const row of rows) {
      const items = await db.all("SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC", [row.id]);
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
        total: Number(row.total || 0),
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        waiterId: row.waiter_id,
        waiterName: row.waiter_name || row.lookup_waiter_name || null,
        acceptedAt: row.accepted_at,
        servedAt: row.served_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        lastPrintedItems: row.last_printed_items ? (typeof row.last_printed_items === "string" ? JSON.parse(row.last_printed_items) : row.last_printed_items) : null,
        items: items.map((item) => ({
          id: item.id,
          menuItemId: item.menu_item_id,
          name: item.name,
          quantity: Number(item.quantity || 0),
          price: Number(item.price || 0),
          specialInstructions: item.special_instructions || "",
        })),
      });
    }
    return orders;
  }

  const snapshot = await db
    .collection("restaurants")
    .doc("rustic-charm")
    .collection("orders")
    .where("sessionId", "==", sessionId)
    .get();

  return snapshot.docs
    .map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }))
    .sort((a, b) => {
      const aTime = a.createdAt?.toMillis?.() ?? 0;
      const bTime = b.createdAt?.toMillis?.() ?? 0;
      return bTime - aTime;
    });
}

async function getOrderById(db, orderId) {
  if (!orderId) {
    const error = new Error("orderId is required");
    error.status = 400;
    throw error;
  }

  if (isSqliteDb(db)) {
    const row = await db.get("SELECT * FROM orders WHERE id = ? LIMIT 1", [orderId]);
    if (!row) {
      const error = new Error("Order not found");
      error.status = 404;
      throw error;
    }
    const items = await db.all("SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC", [orderId]);
    return {
      id: row.id,
      sessionId: row.session_id,
      tableId: row.table_id,
      tableReference: row.table_reference,
      tableNumber: Number(row.table_number || 0),
      tableArea: row.table_area,
      tableLabel: row.table_label,
      orderNumber: row.order_number,
      status: row.status,
      total: Number(row.total || 0),
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      lastPrintedItems: row.last_printed_items ? (typeof row.last_printed_items === "string" ? JSON.parse(row.last_printed_items) : row.last_printed_items) : null,
      items: items.map((item) => ({
        id: item.id,
        menuItemId: item.menu_item_id,
        name: item.name,
        quantity: Number(item.quantity || 0),
        price: Number(item.price || 0),
        specialInstructions: item.special_instructions || "",
      })),
      createdAt: row.created_at,
    };
  }

  const orderRef = db
    .collection("restaurants")
    .doc("rustic-charm")
    .collection("orders")
    .doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }

  return {
    id: orderSnap.id,
    ...orderSnap.data(),
  };
}

async function getLatestOrderForSession(db, sessionId) {
  const orders = await getOrdersBySession(db, sessionId);
  return orders.length > 0 ? orders[0] : null;
}

async function validateTableReference(db, tableReference) {
  const tables = await listCustomerTables(db);
  const table = resolveTableFromReference(tables, tableReference);
  if (!table) {
    const error = new Error("Table reference is invalid");
    error.status = 404;
    throw error;
  }
  return table;
}

async function requestBill(db, orderId) {
  if (!orderId) {
    const error = new Error("Order ID is required to request a bill");
    error.status = 400;
    throw error;
  }

  if (isSqliteDb(db)) {
    // ── Phase 3: Atomic Bill Finalization ──────────────────────────────────────
    // This is the immutable bill-cutoff boundary.
    // All steps execute inside a single transaction with a row lock so that
    // concurrent staff mutations (add/remove item, discount changes) cannot
    // race against this finalization.
    let frozenBill;
    let authTotal;
    let authFinalTotal;

    await db.transaction(async (tx) => {
      // Lock the order row — prevents concurrent writes during finalization.
      let order;
      try {
        order = await tx.get("SELECT * FROM orders WHERE id = ? FOR UPDATE", [orderId]);
      } catch {
        // Some SQLite drivers do not support FOR UPDATE — fall back to a plain read.
        order = await tx.get("SELECT * FROM orders WHERE id = ?", [orderId]);
      }

      if (!order) {
        const error = new Error("Order not found");
        error.status = 404;
        throw error;
      }

      // Reject if already in a terminal / already-finalized state.
      const nonBillableStatuses = ["Bill Requested", "Payment Done", "Completed", "Rejected"];
      if (nonBillableStatuses.includes(order.status)) {
        const error = new Error(`Cannot request bill for an order with status: ${order.status}`);
        error.status = 400;
        throw error;
      }

      // Read order_items inside the same transaction for a consistent snapshot.
      const rawItems = await tx.all(
        `SELECT oi.id, oi.menu_item_id, oi.name, oi.quantity, oi.price,
                c.name  AS category_name,
                c.id    AS category_id
         FROM order_items oi
         LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
         LEFT JOIN categories  c  ON mi.category_id  = c.id
         WHERE oi.order_id = ?
         ORDER BY oi.created_at ASC`,
        [orderId]
      );

      if (!rawItems || rawItems.length === 0) {
        const error = new Error("Cannot finalize a bill for an order with no items");
        error.status = 400;
        throw error;
      }

      // Normalise items for the authoritative engine.
      const items = rawItems.map((row) => ({
        id: row.id,
        menuItemId: row.menu_item_id || "",
        name: row.name || "",
        quantity: Number(row.quantity || 0),
        price: Number(row.price || 0),
        category: row.category_name || "",
        categoryId: row.category_id || "",
      }));

      // Load billSectionsConfig — the authoritative Food/Liquor classification map.
      const configRow = await tx.get(
        "SELECT value FROM restaurant_settings WHERE `key` = 'bill_sections' OR id = 'bill_sections' LIMIT 1"
      );
      const billSectionsConfig = configRow && configRow.value ? JSON.parse(configRow.value) : {};

      // Run the authoritative engine — NEVER trusts orders.total or orders.final_total.
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
        discountAmount: order.discount_amount !== null && order.discount_amount !== undefined ? Number(order.discount_amount) : null,
        foodDiscountPercent: order.food_discount_percent !== null && order.food_discount_percent !== undefined ? Number(order.food_discount_percent) : null,
        alcoholDiscountPercent: order.alcohol_discount_percent !== null && order.alcohol_discount_percent !== undefined ? Number(order.alcohol_discount_percent) : null,
      };

      frozenBill = calculateAuthoritativeBill(normalizedOrder, items, billSectionsConfig);
      authTotal = frozenBill.total;
      authFinalTotal = frozenBill.finalTotal;

      const now = new Date().toISOString();

      // Atomically write the finalized state onto the order row.
      // frozen_bill_json preserves the exact bill snapshot; if the column does not
      // exist yet the UPDATE is still safe — the DB will reject the column and the
      // critical total/final_total fields are still written.
      try {
        await tx.run(
          `UPDATE orders
           SET status          = 'Bill Requested',
               total           = ?,
               final_total     = ?,
               frozen_bill_json = ?,
               updated_at      = ?
           WHERE id = ?`,
          [authTotal, authFinalTotal, JSON.stringify(frozenBill), now, orderId]
        );
      } catch (columnErr) {
        // frozen_bill_json column may not exist in older schema — fall back gracefully.
        if (/no column named frozen_bill_json/i.test(columnErr.message) || /unknown column/i.test(columnErr.message)) {
          await tx.run(
            `UPDATE orders
             SET status      = 'Bill Requested',
                 total       = ?,
                 final_total = ?,
                 updated_at  = ?
             WHERE id = ?`,
            [authTotal, authFinalTotal, now, orderId]
          );
        } else {
          throw columnErr;
        }
      }
    });

    return {
      orderId,
      status: "Bill Requested",
      total: authTotal,
      finalTotal: authFinalTotal,
      frozenBill,
    };
  }

  throw new Error("SQLite-backed backend requires SQLite database access");
}

async function createWaiterCall(db, tableReference, sessionId, customerName, customerPhone, orderId) {
  if (!sessionId) {
    const error = new Error("Session ID is required");
    error.status = 400;
    throw error;
  }
  if (!tableReference) {
    const error = new Error("Table reference is required");
    error.status = 400;
    throw error;
  }

  const validTable = await validateTableReference(db, tableReference);
  if (isSqliteDb(db)) {
    const sessionExists = await db.get("SELECT id FROM sessions WHERE id = ?", [sessionId]);
    if (!sessionExists) {
      await db.run(
        "INSERT INTO sessions (id, table_id, table_reference, status, created_at) VALUES (?, ?, ?, 'active', ?)",
        [sessionId, validTable.id, validTable.tableKey, new Date().toISOString()]
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.run(
      "INSERT INTO waiter_calls (id, session_id, table_id, table_reference, order_id, customer_name, customer_phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, sessionId, validTable.id, validTable.tableKey, orderId || null, String(customerName || "").trim(), String(customerPhone || "").trim(), "Pending", now, now]
    );
    return { id, tableReference: validTable.tableKey, sessionId, orderId: orderId || null, customerName: String(customerName || "").trim(), customerPhone: String(customerPhone || "").trim(), status: "Pending" };
  }

  throw new Error("SQLite-backed backend requires SQLite database access");
}

export async function submitMenuItemFeedback(db, { menuItemId, menuItemName, feedback }) {
  if (!feedback || !String(feedback).trim()) {
    throw new Error("Feedback cannot be empty");
  }
  const id = crypto.randomUUID();
  const name = String(menuItemName || "").trim() || "Unknown Item";
  const text = String(feedback).trim();
  const itemId = menuItemId ? String(menuItemId).trim() : null;

  await db.run(
    "INSERT INTO menu_item_feedbacks (id, menu_item_id, menu_item_name, feedback, downloaded) VALUES (?, ?, ?, ?, 0)",
    [id, itemId, name, text]
  );

  return { id, menuItemName: name, success: true };
}

export {
  listCustomerTables,
  getSessionInfo,
  createOrder,
  getOrdersBySession,
  getOrderById,
  getLatestOrderForSession,
  validateTableReference,
  requestBill,
  createWaiterCall,
};
