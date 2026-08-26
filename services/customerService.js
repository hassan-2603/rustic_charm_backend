import crypto from "crypto";

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

function resolveTableFromReference(tables, reference) {
  if (!reference) return null;
  const normalizedReference = normalizeTableReference(reference);
  if (!normalizedReference) return null;

  return (
    tables.find((table) => {
      const tableKey = normalizeTableReference(table.tableKey || table.id || buildTableKey(table.area || table.areaLabel || "", table.tableNumber));
      const displayName = normalizeTableReference(table.displayName || `${table.areaLabel || getAreaLabel(table.area)} - Table ${table.tableNumber}`);
      const areaKey = normalizeTableReference(table.area);
      const areaLabel = normalizeTableReference(table.areaLabel || getAreaLabel(table.area));
      const tableNumber = normalizeTableReference(table.tableNumber);
      const areaTableRef = normalizeTableReference(`${table.area || table.areaLabel || ""}-${table.tableNumber || ""}`);
      const labelledRef = normalizeTableReference(`${table.areaLabel || areaKey || ""}-${tableNumber}`);

      return (
        tableKey === normalizedReference ||
        displayName === normalizedReference ||
        areaKey === normalizedReference ||
        areaTableRef === normalizedReference ||
        labelledRef === normalizedReference ||
        normalizeTableReference(`${table.area || ""}-${table.tableNumber || ""}`) === normalizedReference
      );
    }) || null
  );
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
  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM tables ORDER BY area ASC, table_number ASC");
    return rows.map((row) => ({
      id: row.id,
      tableKey: row.table_key,
      tableNumber: Number(row.table_number),
      area: row.area,
      areaLabel: row.area_label || row.area,
      displayName: row.display_name || `${row.area_label || row.area} - Table ${row.table_number}`,
      occupied: row.occupied === 1 || row.occupied === true || row.occupied === "1",
      status: row.status || "available",
      currentOrderId: row.current_order_id || "",
      currentSessionId: row.current_session_id || "",
    }));
  }

  const snapshot = await db
    .collection("restaurants")
    .doc("rustic-charm")
    .collection("tables")
    .get();
  return snapshot.docs
    .map(enrichTable)
    .sort((a, b) => {
      const areaOrder = String(a.area || "").localeCompare(String(b.area || ""));
      if (areaOrder !== 0) return areaOrder;
      return Number(a.tableNumber || 0) - Number(b.tableNumber || 0);
    });
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
  return items.map((item) => ({
    menuItemId: item.menuItem?.id || "",
    name: typeof item.menuItem?.name === "object" ? item.menuItem?.name.English || Object.values(item.menuItem?.name)[0] || "" : item.menuItem?.name || "",
    quantity: Number(item.quantity) || 1,
    price: Number(item.selectedPriceOption?.amount ?? item.menuItem?.price ?? 0),
    specialInstructions: item.specialInstructions || "",
  }));
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
    const rows = await db.all("SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC", [sessionId]);
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
        waiterName: row.waiter_name,
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
    const order = await db.get("SELECT id, status FROM orders WHERE id = ? LIMIT 1", [orderId]);
    if (!order) {
      const error = new Error("Order not found");
      error.status = 404;
      throw error;
    }
    const nonBillableStatuses = ["Bill Requested", "Payment Done", "Completed", "Rejected"];
    if (nonBillableStatuses.includes(order.status)) {
      const error = new Error(`Cannot request bill for an order with status: ${order.status}`);
      error.status = 400;
      throw error;
    }
    await db.run("UPDATE orders SET status = 'Bill Requested', updated_at = ? WHERE id = ?", [new Date().toISOString(), orderId]);
    return { orderId, status: "Bill Requested" };
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
