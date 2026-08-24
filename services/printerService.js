import crypto from "node:crypto";

// A printer is considered OFFLINE if the connector hasn't polled for jobs
// in this long. "Configured" (has an IP/name saved) is NOT the same as
// "reachable" -- this heartbeat is what actually answers "is it reachable".
const PRINTER_ONLINE_THRESHOLD_MS = 20_000;

// Failed jobs are retried automatically up to this many attempts before
// they're left FAILED for the admin to retry manually. Keeps a printer
// that's briefly off from silently dropping a bill, without retrying
// forever per the "no infinite retry" requirement.
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Any category whose name contains one of these words (case-insensitive) is
 * treated as an alcoholic / liquor category. Mirrors
 * frontend/src/utils/discountUtils.ts so the printed bill's Food/Liquor
 * split always matches what the waiter and admin see on screen.
 */
const ALCOHOL_KEYWORDS = ["beer", "wine", "liquor", "liqueur", "cocktail", "spirits", "alcohol", "whisky", "whiskey", "vodka", "rum", "gin", "tequila", "brandy"];

function getCategoryText(rawCategory) {
  if (!rawCategory) return "";
  let value = rawCategory;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      value = JSON.parse(value);
    } catch {
      // keep as string
    }
  }
  if (typeof value === "object" && value !== null) {
    return String(value.English || value.en || Object.values(value).find((v) => typeof v === "string" && v.trim()) || "");
  }
  return String(value);
}

function isAlcoholCategory(rawCategory) {
  const text = getCategoryText(rawCategory).toLowerCase();
  if (!text) return false;
  return ALCOHOL_KEYWORDS.some((keyword) => text.includes(keyword));
}

function splitItemsByCategory(items) {
  const foodItems = [];
  const alcoholItems = [];
  for (const item of items || []) {
    if (isAlcoholCategory(item.category)) alcoholItems.push(item);
    else foodItems.push(item);
  }
  const sum = (list) => list.reduce((total, item) => total + Number(item.price || 0) * Number(item.quantity || 0), 0);
  return { foodItems, alcoholItems, foodTotal: sum(foodItems), alcoholTotal: sum(alcoholItems) };
}

function rowToPrinterConfig(row) {
  if (!row) return null;
  const lastSeenAt = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  const online = lastSeenAt > 0 && Date.now() - lastSeenAt < PRINTER_ONLINE_THRESHOLD_MS;
  return {
    id: row.id,
    printerName: row.printer_name || "",
    connectionType: row.connection_type || "network",
    ipAddress: row.ip_address || "",
    port: row.port || null,
    paperWidth: row.paper_width || "80mm",
    copies: row.copies || 1,
    autoCut: !!row.auto_cut,
    autoPrint: !!row.auto_print,
    configured: row.connection_type === "windows" ? !!row.printer_name : !!(row.ip_address && row.port),
    status: online ? "READY" : "OFFLINE",
    lastSeenAt: row.last_seen_at || null,
  };
}

export async function getPrinterConfig(db, printerId) {
  if (!["bill", "kot"].includes(printerId)) throw Object.assign(new Error("Printer must be 'bill' or 'kot'"), { status: 400 });
  const row = await db.get("SELECT * FROM printers WHERE id = ?", [printerId]);
  return rowToPrinterConfig(row);
}

export async function getAllPrinterConfigs(db) {
  const rows = await db.all("SELECT * FROM printers");
  const byId = Object.fromEntries(rows.map((row) => [row.id, rowToPrinterConfig(row)]));
  return { bill: byId.bill || null, kot: byId.kot || null };
}

export async function savePrinterConfig(db, printerId, settings) {
  if (!["bill", "kot"].includes(printerId)) throw Object.assign(new Error("Printer must be 'bill' or 'kot'"), { status: 400 });
  const connectionType = settings.connectionType === "windows" ? "windows" : "network";
  const paperWidth = settings.paperWidth === "58mm" ? "58mm" : "80mm";
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO printers (id, printer_name, connection_type, ip_address, port, paper_width, copies, auto_cut, auto_print, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       printer_name = excluded.printer_name,
       connection_type = excluded.connection_type,
       ip_address = excluded.ip_address,
       port = excluded.port,
       paper_width = excluded.paper_width,
       copies = excluded.copies,
       auto_cut = excluded.auto_cut,
       auto_print = excluded.auto_print,
       updated_at = excluded.updated_at`,
    [
      printerId,
      settings.printerName || "",
      connectionType,
      settings.ipAddress || "",
      settings.port ? Number(settings.port) : null,
      paperWidth,
      Math.max(1, Number(settings.copies) || 1),
      settings.autoCut === false ? 0 : 1,
      settings.autoPrint ? 1 : 0,
      now,
    ]
  );
  return getPrinterConfig(db, printerId);
}

/** Heartbeat: called every time the connector polls for jobs. */
export async function markPrinterSeen(db, printerId) {
  if (!["bill", "kot"].includes(printerId)) return;
  await db.run("UPDATE printers SET last_seen_at = ? WHERE id = ?", [new Date().toISOString(), printerId]);
}

async function getOrderForPrint(db, orderId) {
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  const items = await db.all(
    `SELECT order_items.*, categories.name AS category_name
     FROM order_items
     LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
     LEFT JOIN categories ON menu_items.category_id = categories.id
     WHERE order_items.order_id = ?
     ORDER BY order_items.created_at ASC`,
    [orderId]
  );
  return {
    id: order.id,
    orderNumber: order.order_number,
    tableLabel: order.table_label || order.table_reference || order.table_number,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    waiterName: order.waiter_name,
    createdAt: order.created_at,
    total: Number(order.total || 0),
    discountMode: order.discount_mode,
    discountAmount: Number(order.discount_amount || 0),
    finalTotal: order.final_total !== null && order.final_total !== undefined ? Number(order.final_total) : Number(order.total || 0),
    foodDiscountPercent: Number(order.food_discount_percent || 0),
    alcoholDiscountPercent: Number(order.alcohol_discount_percent || 0),
    foodDiscountAmount: Number(order.food_discount_amount || 0),
    alcoholDiscountAmount: Number(order.alcohol_discount_amount || 0),
    items: items.map((item) => ({
      name: item.name,
      category: item.category_name || "",
      quantity: Number(item.quantity || 0),
      price: Number(item.price || 0),
    })),
  };
}

function buildBillPayload(order) {
  const { foodItems, alcoholItems, foodTotal, alcoholTotal } = splitItemsByCategory(order.items);
  const toLine = (item) => ({ name: item.name, quantity: item.quantity, price: item.price, amount: item.price * item.quantity });
  const isCategoryDiscount = order.discountMode === "category";
  return {
    orderNumber: order.orderNumber,
    tableNumber: order.tableLabel,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    waiterName: order.waiterName,
    date: new Date(order.createdAt || Date.now()).toLocaleString(),
    items: order.items.map(toLine),
    foodItems: foodItems.map(toLine),
    alcoholItems: alcoholItems.map(toLine),
    foodTotal,
    alcoholTotal,
    total: order.total,
    discountMode: order.discountMode || null,
    discountAmount: order.discountAmount || 0,
    finalTotal: order.finalTotal,
    foodDiscountPercent: isCategoryDiscount ? order.foodDiscountPercent || 0 : 0,
    alcoholDiscountPercent: isCategoryDiscount ? order.alcoholDiscountPercent || 0 : 0,
    foodDiscountAmount: isCategoryDiscount ? order.foodDiscountAmount || 0 : 0,
    alcoholDiscountAmount: isCategoryDiscount ? order.alcoholDiscountAmount || 0 : 0,
  };
}

function buildKotPayload(order) {
  return {
    orderNumber: order.orderNumber,
    tableNumber: order.tableLabel,
    waiterName: order.waiterName,
    date: new Date(order.createdAt || Date.now()).toLocaleString(),
    items: order.items.map((item) => ({ name: item.name, quantity: item.quantity })),
  };
}

function rowToJob(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    type: row.type,
    printerId: row.printer_id,
    status: row.status,
    isTest: !!row.is_test,
    createdBy: row.created_by,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    printedAt: row.printed_at,
  };
}

/**
 * printBill(orderId) / printKOT(orderId), unified: identifies the printer
 * role from `type`, loads that printer's restaurant-level configuration,
 * builds the print content from the order, and queues a job. This is the
 * ONE function both the waiter dashboard and the admin panel call --
 * neither has its own copy of this logic.
 */
export async function createPrintJob(db, { orderId, type, createdBy, isTest = false }) {
  const normalizedType = String(type || "").toUpperCase();
  if (!["BILL", "KOT"].includes(normalizedType)) {
    throw Object.assign(new Error("Print type must be BILL or KOT"), { status: 400 });
  }
  const printerId = normalizedType === "BILL" ? "bill" : "kot";

  const printer = await getPrinterConfig(db, printerId);
  if (!printer?.configured) {
    throw Object.assign(new Error(`The ${normalizedType === "BILL" ? "Bill" : "KOT"} printer has not been configured yet. Ask an admin to set it up in Printer Settings.`), { status: 409 });
  }

  let payload;
  if (isTest) {
    payload = { test: true };
  } else {
    if (!orderId) throw Object.assign(new Error("orderId is required"), { status: 400 });
    const order = await getOrderForPrint(db, orderId);
    payload = normalizedType === "BILL" ? { bill: buildBillPayload(order) } : { kot: buildKotPayload(order) };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO print_jobs (id, order_id, type, printer_id, status, payload, is_test, created_by, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, 0, ?, ?, ?)`,
    [id, orderId || null, normalizedType, printerId, JSON.stringify(payload), isTest ? 1 : 0, createdBy || null, DEFAULT_MAX_ATTEMPTS, now, now]
  );

  const row = await db.get("SELECT * FROM print_jobs WHERE id = ?", [id]);
  return rowToJob(row);
}

export async function getPrintJob(db, jobId) {
  const row = await db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId]);
  if (!row) throw Object.assign(new Error("Print job not found"), { status: 404 });
  return rowToJob(row);
}

export async function listFailedJobs(db) {
  const rows = await db.all("SELECT * FROM print_jobs WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 50");
  return rows.map(rowToJob);
}

/** Admin (or waiter, on their own job) explicitly asks to print again. */
export async function retryPrintJob(db, jobId) {
  const row = await db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId]);
  if (!row) throw Object.assign(new Error("Print job not found"), { status: 404 });
  const now = new Date().toISOString();
  await db.run(
    "UPDATE print_jobs SET status = 'PENDING', error_message = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?",
    [now, jobId]
  );
  const updated = await db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId]);
  return rowToJob(updated);
}

/**
 * Called by the restaurant connector's poll loop -- and ONLY by it (the
 * connector route enforces the shared secret). Atomically claims a batch
 * of PENDING jobs as PROCESSING so two connector instances (or a retry
 * racing a poll) can never both print the same job, then returns each job
 * together with the printer settings it should be sent to.
 */
export async function claimPendingJobs(db, limit = 5) {
  await markPrinterSeen(db, "bill");
  await markPrinterSeen(db, "kot");

  const pending = await db.all(
    "SELECT * FROM print_jobs WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?",
    [Math.max(1, Math.min(20, Number(limit) || 5))]
  );
  if (pending.length === 0) return [];

  const now = new Date().toISOString();
  const claimed = [];
  for (const row of pending) {
    // Guard against a race with a concurrent poll/retry by only claiming
    // rows still PENDING at the moment of the UPDATE.
    const result = await db.run(
      "UPDATE print_jobs SET status = 'PROCESSING', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'",
      [now, now, row.id]
    );
    if (result.changes > 0) claimed.push(row);
  }

  const printers = await getAllPrinterConfigs(db);
  return claimed.map((row) => ({
    ...rowToJob({ ...row, status: "PROCESSING" }),
    payload: JSON.parse(row.payload),
    printer: printers[row.printer_id],
  }));
}

/** Called by the connector after it attempts a claimed job. */
export async function reportPrintJobResult(db, jobId, { status, errorMessage }) {
  const row = await db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId]);
  if (!row) throw Object.assign(new Error("Print job not found"), { status: 404 });

  const now = new Date().toISOString();

  if (status === "PRINTED") {
    await db.run("UPDATE print_jobs SET status = 'PRINTED', error_message = NULL, printed_at = ?, updated_at = ? WHERE id = ?", [now, now, jobId]);
  } else {
    // Failed: auto-retry a limited number of times, then leave it FAILED
    // for the admin to retry manually. Never retries forever.
    const willRetry = row.attempts < row.max_attempts;
    await db.run(
      `UPDATE print_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      [willRetry ? "PENDING" : "FAILED", errorMessage || "Print failed", now, jobId]
    );
  }

  const updated = await db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId]);
  return rowToJob(updated);
}
