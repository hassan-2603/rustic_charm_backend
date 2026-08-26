import express from "express";
import { buildApiResponse, buildApiError } from "../services/apiService.js";
import {
  getWaiters,
  getWaiterCalls,
  getTables,
  updateTable,
  getOrders,
  updateOrder,
  addOrderItems,
  removeOrderItems,
  updateOrderItemPrices,
  deleteOrder,
  saveOrderSplits,
  getOrderSplits,
  createAdminOrder,
  getKitchenCredentials,
} from "../services/adminService.js";
import { createPrintJob, getPrintJob, retryPrintJob } from "../services/printerService.js";

// This router is intentionally NOT behind adminAuthMiddleware.
//
// Waiters authenticate with their own Waiter ID + PIN (checked against the
// `waiters` collection), and Kitchen authenticates with its own
// Kitchen ID + password (checked against `kitchen-credentials`). Neither of
// those requires — or should require — a Firebase admin session on the
// device. Requiring admin auth here was the bug: it meant a waiter/kitchen
// device could never log in unless someone had already signed into the
// admin dashboard on that exact device.
//
// Only the read/update operations waiter & kitchen apps actually need are
// exposed here. Anything destructive or configuration-level (menu edits,
// deleting orders in bulk, creating/removing waiters, changing the kitchen
// password, etc.) stays under /api/admin and requires an admin token.

const router = express.Router();

// Handle CORS preflight requests
router.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

// ==========================================
// WAITER LOGIN LOOKUP
// ==========================================
router.get("/waiters", async (req, res, next) => {
  try {
    const waiters = await getWaiters(req.app.locals.db);
    res.json(buildApiResponse(waiters));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/waiter-calls", async (req, res, next) => {
  try {
    const calls = await getWaiterCalls(req.app.locals.db);
    res.json(buildApiResponse(calls));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// ==========================================
// KITCHEN LOGIN LOOKUP (read-only — password changes stay admin-only)
// ==========================================
router.get("/kitchen-credentials", async (req, res, next) => {
  try {
    const credentials = await getKitchenCredentials(req.app.locals.db);
    res.json(buildApiResponse(credentials));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// ==========================================
// ORDERS — waiter & kitchen both need to read/update live orders
// ==========================================
router.get("/orders", async (req, res, next) => {
  try {
    const orders = await getOrders(req.app.locals.db);
    res.json(buildApiResponse(orders));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/orders/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Order ID is required" });
    }
    const updatedOrder = await updateOrder(req.app.locals.db, id, updates);
    res.json(buildApiResponse(updatedOrder));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// Add item(s) to an existing order ("Add Item" button on the waiter's My Orders card)
router.post("/orders/:id/items", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { items } = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Order ID is required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "At least one item is required" });
    }
    const updatedOrder = await addOrderItems(req.app.locals.db, id, items);
    res.json(buildApiResponse(updatedOrder));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// Remove item(s) from an existing order ("Remove Item" button on the waiter's My Orders card)
router.delete("/orders/:id/items", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { itemIds } = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Order ID is required" });
    }
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ ok: false, error: "At least one item is required" });
    }
    const updatedOrder = await removeOrderItems(req.app.locals.db, id, itemIds);
    res.json(buildApiResponse(updatedOrder));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// Cancel (permanently delete) a single order ("Cancel" button on the waiter's My Orders card)
router.delete("/orders/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: "Order ID is required" });
    }
    const result = await deleteOrder(req.app.locals.db, id);
    res.json(buildApiResponse(result));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// Update order item prices
router.put("/orders/:id/items/prices", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { updates } = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Order ID is required" });
    }
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ ok: false, error: "At least one item price update is required" });
    }
    const updatedOrder = await updateOrderItemPrices(req.app.locals.db, id, updates);
    res.json(buildApiResponse(updatedOrder));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// Waiter's "Order by Captain" flow places an order directly on behalf of a
// table/waiter, same shape as the admin order-creation endpoint.
router.post("/orders", async (req, res, next) => {
  try {
    const order = await createAdminOrder(req.app.locals.db, req.body || {});
    res.status(201).json(buildApiResponse(order));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

// ==========================================
// PRINTING — waiter's "Print Bill" / "Print KOT" buttons.
//
// The waiter's phone NEVER talks to a printer. It only creates a row in
// the centralized print_jobs queue via this exact same createPrintJob()
// function the Admin panel uses (see routes/admin.js) — no printer logic
// is duplicated here. The restaurant's print connector (running on a
// restaurant PC, not the waiter's device) picks the job up on its own.
// ==========================================
router.post("/print-jobs", async (req, res, next) => {
  try {
    const { orderId, type } = req.body || {};
    const waiterId = req.body?.waiterId;
    const job = await createPrintJob(req.app.locals.db, {
      orderId,
      type,
      createdBy: waiterId ? `waiter:${waiterId}` : "waiter",
    });
    res.status(201).json(buildApiResponse(job));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

router.get("/print-jobs/:id", async (req, res, next) => {
  try {
    const job = await getPrintJob(req.app.locals.db, req.params.id);
    res.json(buildApiResponse(job));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

// Waiter explicitly presses "Retry" after a failed print.
router.post("/print-jobs/:id/retry", async (req, res, next) => {
  try {
    const job = await retryPrintJob(req.app.locals.db, req.params.id);
    res.json(buildApiResponse(job));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});


// ==========================================
// ORDER BILL SPLITS
// ==========================================
router.get("/orders/:id/splits", async (req, res, next) => {
  try {
    const splits = await getOrderSplits(req.app.locals.db, req.params.id);
    res.json(buildApiResponse(splits));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.post("/orders/:id/splits", async (req, res, next) => {
  try {
    const { splits } = req.body || {};
    const result = await saveOrderSplits(req.app.locals.db, req.params.id, splits || []);
    res.status(201).json(buildApiResponse(result));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// ==========================================
// TABLES — waiter needs to free/occupy tables when ending a session
// ==========================================
router.get("/tables", async (req, res, next) => {
  try {
    const tables = await getTables(req.app.locals.db);
    res.json(buildApiResponse(tables));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/tables/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Table ID is required" });
    }
    const table = await updateTable(req.app.locals.db, id, updates);
    res.json(buildApiResponse(table));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

export default router;
