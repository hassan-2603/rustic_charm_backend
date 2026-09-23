import crypto from "node:crypto";
import { calculateAuthoritativeBill } from "./billCalculationService.js";
import { getEffectiveBillSections, resolveEnglishItemName } from "./adminService.js";

// A printer is considered OFFLINE if the connector hasn't polled for jobs
// in this long. "Configured" (has an IP/name saved) is NOT the same as
// "reachable" -- this heartbeat is what actually answers "is it reachable".
const PRINTER_ONLINE_THRESHOLD_MS = 20_000;

// Failed jobs are retried automatically up to this many attempts before
// they're left FAILED for the admin to retry manually. Keeps a printer
// that's briefly off from silently dropping a bill, without retrying
// forever per the "no infinite retry" requirement.
const DEFAULT_MAX_ATTEMPTS = 5;

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

export function isAlcoholCategory(rawCategory) {
  const text = getCategoryText(rawCategory).toLowerCase();
  if (!text) return false;
  return ALCOHOL_KEYWORDS.some((keyword) => text.includes(keyword));
}

export const isAlcoholCategoryName = isAlcoholCategory;

function splitItemsByCategory(items, billSectionsConfig) {
  const foodItems = [];
  const alcoholItems = [];
  for (const item of items || []) {
    let isAlcohol = false;
    const catId = item.categoryId || item.category_id;
    if (billSectionsConfig && catId && billSectionsConfig[catId]) {
      isAlcohol = billSectionsConfig[catId] === "Liquor";
    } else {
      isAlcohol = isAlcoholCategory(item.category);
    }

    if (isAlcohol) alcoholItems.push(item);
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
  const rawIp = (settings.ipAddress || "").trim();
  const connectionType = settings.connectionType === "windows" && !rawIp ? "windows" : (settings.connectionType || "network");
  const paperWidth = settings.paperWidth === "58mm" ? "58mm" : "80mm";
  const port = settings.port ? Number(settings.port) : (connectionType === "network" ? 9100 : null);
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO printers (id, printer_name, connection_type, ip_address, port, paper_width, copies, auto_cut, auto_print, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       printer_name = VALUES(printer_name),
       connection_type = VALUES(connection_type),
       ip_address = VALUES(ip_address),
       port = VALUES(port),
       paper_width = VALUES(paper_width),
       copies = VALUES(copies),
       auto_cut = VALUES(auto_cut),
       auto_print = VALUES(auto_print),
       updated_at = VALUES(updated_at)`,
    [
      printerId,
      (settings.printerName || "").trim(),
      connectionType,
      rawIp,
      port,
      paperWidth,
      Math.max(1, Number(settings.copies) || 1),
      settings.autoCut === false ? 0 : 1,
      settings.autoPrint ? 1 : 0,
      now,
    ]
  );
  return getPrinterConfig(db, printerId);
}

const lastSeenThrottles = new Map();
const HEARTBEAT_THROTTLE_MS = 8000;

/** Heartbeat: called every time the connector polls for jobs. Throttled to avoid unnecessary DB writes. */
export async function markPrinterSeen(db, printerId) {
  if (!["bill", "kot"].includes(printerId)) return;
  const now = Date.now();
  const lastUpdate = lastSeenThrottles.get(printerId) || 0;
  if (now - lastUpdate < HEARTBEAT_THROTTLE_MS) return;
  lastSeenThrottles.set(printerId, now);
  await db.run("UPDATE printers SET last_seen_at = ? WHERE id = ?", [new Date(now).toISOString(), printerId]);
}

async function getOrderForPrint(db, orderId) {
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  const items = await db.all(
    `SELECT order_items.*,
            COALESCE(menu_items.name, mi_trans.name, '')            AS mi_name,
            COALESCE(categories.name, menu_items.category_name, mi_trans.category_name, '') AS category_name,
            COALESCE(categories.id, menu_items.category_id, mi_trans.category_id, '')     AS category_id,
            COALESCE(menu_items.category_name, mi_trans.category_name, '') AS mi_category_name,
            COALESCE(menu_items.category_id, mi_trans.category_id, '')   AS mi_category_id
       FROM order_items
       LEFT JOIN menu_items ON (order_items.menu_item_id = menu_items.id OR (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(menu_items.name))))
       LEFT JOIN menu_translations mt ON (order_items.menu_item_id IS NULL AND LOWER(TRIM(order_items.name)) = LOWER(TRIM(mt.name)))
       LEFT JOIN menu_items mi_trans ON mt.menu_item_id = mi_trans.id
       LEFT JOIN categories ON COALESCE(menu_items.category_id, mi_trans.category_id) = categories.id
       WHERE order_items.order_id = ?
       ORDER BY order_items.created_at ASC`,
    [orderId]
  );

  const mappedItems = items.map((item) => ({
    id: item.id,
    menuItemId: item.menu_item_id || "",
    name: resolveEnglishItemName(item),
    category: item.category_name || item.mi_category_name || "",
    categoryId: item.category_id || item.mi_category_id || "",
    quantity: Number(item.quantity || 0),
    price: Number(item.price || 0),
  }));

  // Authoritative total strictly calculated from the order items
  const itemsTotal = mappedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  // Self-heal orders.total in the database if it ever became out of sync
  if (Math.abs(Number(order.total || 0) - itemsTotal) > 0.01) {
    db.run("UPDATE orders SET total = ? WHERE id = ?", [itemsTotal, orderId]).catch((err) => {
      console.warn("[printerService] Auto-sync order total failed:", err.message);
    });
  }

  return {
    id: order.id,
    orderNumber: order.order_number,
    tableLabel: order.table_label || order.table_reference || order.table_number,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    waiterName: order.waiter_name,
    createdAt: order.created_at,
    total: itemsTotal,
    discountMode: order.discount_mode,
    discountAmount: Number(order.discount_amount || 0),
    finalTotal: order.final_total !== null && order.final_total !== undefined ? Number(order.final_total) : itemsTotal,
    foodDiscountPercent: Number(order.food_discount_percent || 0),
    alcoholDiscountPercent: Number(order.alcohol_discount_percent || 0),
    foodDiscountAmount: Number(order.food_discount_amount || 0),
    alcoholDiscountAmount: Number(order.alcohol_discount_amount || 0),
    description: order.description,
    lastPrintedItems: order.last_printed_items ? (typeof order.last_printed_items === "string" ? JSON.parse(order.last_printed_items) : order.last_printed_items) : null,
    items: mappedItems,
  };
}

function resolveSection(item, config = {}) {
  const catId = item.categoryId || item.category_id || "";
  const catName = getCategoryText(item.category || item.category_name || "").trim().toLowerCase();

  // 1. Direct configuration by category ID
  if (catId && config[catId]) {
    return config[catId];
  }

  // 2. Direct configuration by category Name
  if (catName) {
    if (config[catName]) return config[catName];
    for (const [key, section] of Object.entries(config)) {
      if (getCategoryText(key).trim().toLowerCase() === catName) return section;
    }

    // 2b. Slug matching (e.g. catName "Soups" -> config key "cat-soups")
    const slug = "cat-" + catName.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (config[slug]) return config[slug];

    // 2c. Normalized alphanumeric match
    const cleanCatName = catName.replace(/^cat-/, "").replace(/[^a-z0-9]/g, "");
    if (cleanCatName) {
      for (const [key, section] of Object.entries(config)) {
        const cleanKey = getCategoryText(key).trim().toLowerCase().replace(/^cat-/, "").replace(/[^a-z0-9]/g, "");
        if (cleanKey && cleanKey === cleanCatName) return section;
      }
    }
  }

  // Default section when not explicitly assigned to any section
  return "Food";
}

function formatIndiaDateTime(dateInput) {
  const d = dateInput ? (dateInput instanceof Date ? dateInput : new Date(dateInput)) : new Date();
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  return validDate.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export function buildBillPayload(order, billSectionsConfig) {
  // Authoritative bill calculation: single source of truth for all monetary values.
  // FAIL CLOSED: Rejects invalid items, invalid discounts, or unresolvable sections.
  // NEVER consults order.finalTotal or order.total.
  const calculatedBill = calculateAuthoritativeBill(order, order.items, billSectionsConfig);

  return {
    ...calculatedBill,
    date: formatIndiaDateTime(calculatedBill.calculatedAt),
  };
}


function buildKotPayload(order) {
  return {
    orderNumber: order.orderNumber,
    tableNumber: order.tableLabel,
    waiterName: order.waiterName,
    date: formatIndiaDateTime(),
    items: (order.items || []).map((item) => ({ name: resolveEnglishItemName(item), quantity: Number(item.quantity || 1) })),
    addedItems: order.addedItems ? order.addedItems.map((item) => ({ name: resolveEnglishItemName(item), quantity: Number(item.quantity || 1) })) : [],
    removedItems: order.removedItems ? order.removedItems.map((item) => ({ name: resolveEnglishItemName(item), quantity: Number(item.quantity || 1) })) : [],
    description: order.description,
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
export async function createPrintJob(db, { orderId, type, createdBy, isTest = false, action = null, items = null, description = null }) {
  const normalizedType = String(type || "").toUpperCase();
  if (!["BILL", "KOT"].includes(normalizedType)) {
    throw Object.assign(new Error("Print type must be BILL or KOT"), { status: 400 });
  }
  const printerId = normalizedType === "BILL" ? "bill" : "kot";

  const printer = await getPrinterConfig(db, printerId);
  if (!printer?.configured) {
    throw Object.assign(new Error(`The ${normalizedType === "BILL" ? "Bill" : "KOT"} printer has not been configured yet. Ask an admin to set it up in Printer Settings.`), { status: 409 });
  }

  const now = new Date().toISOString();

  if (isTest) {
    const payload = { test: true };
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO print_jobs (id, order_id, type, printer_id, status, payload, is_test, created_by, attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, 0, ?, ?, ?)`,
      [id, null, normalizedType, printerId, JSON.stringify(payload), 1, createdBy || null, DEFAULT_MAX_ATTEMPTS, now, now]
    );
    const row = await db.get("SELECT * FROM print_jobs WHERE id = ?", [id]);
    return rowToJob(row);
  }

  if (!orderId) throw Object.assign(new Error("orderId is required"), { status: 400 });
  const order = await getOrderForPrint(db, orderId);

  if (normalizedType === "BILL") {
    const billSectionsConfig = await getEffectiveBillSections(db);

    const splits = await db.all("SELECT * FROM order_bill_splits WHERE order_id = ? ORDER BY bill_number ASC", [orderId]);
    const billPayloads = [];

    if (splits && splits.length > 0) {
      for (const split of splits) {
        let items = [];
        try {
          items = JSON.parse(split.items_json || "[]");
        } catch (e) { }

        const splitOrder = {
          ...order,
          items: items.map((item) => ({
            ...item,
            name: resolveEnglishItemName(item),
          })),
          total: Number(split.subtotal || 0),
          finalTotal: Number(split.total || split.subtotal || 0),
          discountAmount: 0,
        };

        const payloadObj = buildBillPayload(splitOrder, billSectionsConfig);
        payloadObj.splitLabel = `Split ${split.bill_number} of ${splits.length}`;
        billPayloads.push(payloadObj);
      }
    } else {
      billPayloads.push(buildBillPayload(order, billSectionsConfig));
    }

    const createdJobs = [];
    for (const payloadObj of billPayloads) {
      const id = crypto.randomUUID();
      const payload = { bill: payloadObj };
      await db.run(
        `INSERT INTO print_jobs (id, order_id, type, printer_id, status, payload, is_test, created_by, attempts, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, 0, ?, ?, ?)`,
        [id, orderId, normalizedType, printerId, JSON.stringify(payload), 0, createdBy || null, DEFAULT_MAX_ATTEMPTS, now, now]
      );
      const row = await db.get("SELECT * FROM print_jobs WHERE id = ?", [id]);
      createdJobs.push(rowToJob(row));
    }

    return createdJobs.length === 1 ? createdJobs[0] : createdJobs;
  }

  // KOT Splitting Logic
  const row = await db.get("SELECT value FROM restaurant_settings WHERE `key` = 'kot_sections' OR id = 'kot_sections'");
  const config = row && row.value ? JSON.parse(row.value) : {}; // map of categoryId -> section name

  let addedItemsOverall = [];
  let removedItemsOverall = [];
  let isDiffPrint = false;

  // 1. Explicit action passed from caller (e.g. AddItemModal or RemoveItemModal)
  if (action === "ADD" && Array.isArray(items) && items.length > 0) {
    isDiffPrint = true;
    addedItemsOverall = items.map((i) => ({
      ...i,
      name: resolveEnglishItemName(i),
      quantity: Number(i.quantity || 1),
    }));
  } else if (action === "REMOVE" && Array.isArray(items) && items.length > 0) {
    isDiffPrint = true;
    removedItemsOverall = items.map((i) => ({
      ...i,
      name: resolveEnglishItemName(i),
      quantity: Number(i.quantity || 1),
    }));
  }
 else if (order.lastPrintedItems) {
    // 2. Automatic diff against lastPrintedItems
    isDiffPrint = true;
    const currentItemMap = {};
    for (const item of order.items) {
      const key = item.id || `${item.menuItemId || item.menu_item_id || ""}_${item.name}`;
      currentItemMap[key] = item;
    }
    const lastItemMap = {};
    for (const item of order.lastPrintedItems) {
      const key = item.id || `${item.menuItemId || item.menu_item_id || ""}_${item.name}`;
      lastItemMap[key] = item;
    }

    // Check additions or quantity increases
    for (const item of order.items) {
      const key = item.id || `${item.menuItemId || item.menu_item_id || ""}_${item.name}`;
      const prev = lastItemMap[key];
      if (!prev) {
        addedItemsOverall.push({ ...item });
      } else if (item.quantity > prev.quantity) {
        addedItemsOverall.push({ ...item, quantity: item.quantity - prev.quantity });
      }
    }

    // Check removals or quantity decreases
    for (const item of order.lastPrintedItems) {
      const key = item.id || `${item.menuItemId || item.menu_item_id || ""}_${item.name}`;
      const cur = currentItemMap[key];
      if (!cur) {
        removedItemsOverall.push({ ...item });
      } else if (cur.quantity < item.quantity) {
        removedItemsOverall.push({ ...item, quantity: item.quantity - cur.quantity });
      }
    }

    if (addedItemsOverall.length === 0 && removedItemsOverall.length === 0) {
      isDiffPrint = false; // Just do a full reprint if absolutely no changes
    }
  }

  const sectionItems = {}; // e.g. { "Food": [...], "Bar & Beverages": [...] }
  const sectionAddedItems = {};
  const sectionRemovedItems = {};

  const processItemIntoSection = (item, mapToUpdate) => {
    const sectionName = resolveSection(item, config);
    if (!mapToUpdate[sectionName]) mapToUpdate[sectionName] = [];
    mapToUpdate[sectionName].push(item);
  };

  if (isDiffPrint) {
    for (const item of addedItemsOverall) processItemIntoSection(item, sectionAddedItems);
    for (const item of removedItemsOverall) processItemIntoSection(item, sectionRemovedItems);
  } else {
    for (const item of order.items) processItemIntoSection(item, sectionItems);
  }

  const keys = Array.from(new Set([
    ...Object.keys(sectionItems),
    ...Object.keys(sectionAddedItems),
    ...Object.keys(sectionRemovedItems)
  ]));
  if (keys.length === 0) {
    return []; // Nothing to print
  }

  // Deterministic section ordering: Kitchen Food first, Tandoor second, Bar & Beverages third
  const SECTION_ORDER = {
    "Food": 1,
    "Indian Tandoor": 2,
    "Bar & Beverages": 3,
  };
  keys.sort((a, b) => (SECTION_ORDER[a] || 99) - (SECTION_ORDER[b] || 99) || a.localeCompare(b));

  const createdJobs = [];
  for (const sectionName of keys) {
    const sectionItemsList = sectionItems[sectionName] || [];
    const sectionAddedList = sectionAddedItems[sectionName] || [];
    const sectionRemovedList = sectionRemovedItems[sectionName] || [];

    const kotPayload = buildKotPayload({
      ...order,
      description: description || order.description,
      items: sectionItemsList,
      addedItems: sectionAddedList,
      removedItems: sectionRemovedList
    });
    kotPayload.section = sectionName;

    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO print_jobs (id, order_id, type, printer_id, status, payload, is_test, created_by, attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, 0, ?, ?, ?)`,
      [id, orderId, normalizedType, printerId, JSON.stringify({ kot: kotPayload }), 0, createdBy || null, DEFAULT_MAX_ATTEMPTS, now, now]
    );
    const row = await db.get("SELECT * FROM print_jobs WHERE id = ?", [id]);
    createdJobs.push(rowToJob(row));
  }

  // Update last_printed_items for future diffs
  await db.run("UPDATE orders SET last_printed_items = ? WHERE id = ?", [JSON.stringify(order.items), orderId]);

  // Return the array of print jobs back to the caller
  return createdJobs;
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
    "UPDATE print_jobs SET status = 'PENDING', attempts = 0, error_message = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?",
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

  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Auto-recover abandoned PROCESSING jobs (only from the last 30 minutes, stuck for > 30 seconds).
  const staleThreshold = new Date(now.getTime() - 30000).toISOString();
  const maxJobAge = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  await db.run(
    "UPDATE print_jobs SET status = 'PENDING', claimed_at = NULL, updated_at = ? WHERE status = 'PROCESSING' AND claimed_at IS NOT NULL AND claimed_at < ? AND created_at >= ?",
    [nowIso, staleThreshold, maxJobAge]
  ).catch(() => {});

  // Permanently cancel ancient stuck jobs older than 30 minutes so they never print
  await db.run(
    "UPDATE print_jobs SET status = 'CANCELLED', updated_at = ? WHERE status = 'PROCESSING' AND created_at < ?",
    [nowIso, maxJobAge]
  ).catch(() => {});

  // 2. Identify physical printers currently busy with a job in PROCESSING
  const activeProcessing = await db.all("SELECT printer_id FROM print_jobs WHERE status = 'PROCESSING'");
  const busyPrinterIds = new Set(activeProcessing.map((r) => r.printer_id));

  const printers = await getAllPrinterConfigs(db);
  const busyPhysicalPrinters = new Set();
  for (const pid of busyPrinterIds) {
    const config = printers[pid];
    if (config?.printerName) {
      busyPhysicalPrinters.add(config.printerName.toLowerCase());
    }
  }

  const pending = await db.all(
    "SELECT * FROM print_jobs WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?",
    [Math.max(1, Math.min(20, Number(limit) || 5))]
  );
  if (pending.length === 0) return [];

  const claimed = [];
  const claimedPrinterIds = new Set();
  const claimedPhysicalPrinters = new Set();

  for (const row of pending) {
    const printerConfig = printers[row.printer_id];
    const physicalName = printerConfig?.printerName ? printerConfig.printerName.toLowerCase() : row.printer_id;

    // Do not claim if this physical printer is actively printing another job (PROCESSING)
    // or if we already claimed a job for this printer in this batch!
    if (
      busyPrinterIds.has(row.printer_id) ||
      busyPhysicalPrinters.has(physicalName) ||
      claimedPrinterIds.has(row.printer_id) ||
      claimedPhysicalPrinters.has(physicalName)
    ) {
      continue;
    }

    const result = await db.run(
      "UPDATE print_jobs SET status = 'PROCESSING', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'",
      [nowIso, nowIso, row.id]
    );
    if (result.changes > 0) {
      claimed.push(row);
      claimedPrinterIds.add(row.printer_id);
      claimedPhysicalPrinters.add(physicalName);
    }
  }

  if (claimed.length === 0) return [];

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
    // Failed: auto-retry real orders up to max_attempts, but fail test prints immediately
    // so the admin UI receives the exact failure error right away without waiting.
    const willRetry = !row.is_test && row.attempts < row.max_attempts;
    await db.run(
      `UPDATE print_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      [willRetry ? "PENDING" : "FAILED", errorMessage || "Print failed", now, jobId]
    );
  }

  const updated = await db.get("SELECT * FROM print_jobs WHERE id = ?", [jobId]);
  return rowToJob(updated);
}
