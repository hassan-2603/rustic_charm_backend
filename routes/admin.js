import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { buildApiResponse, buildApiError } from "../services/apiService.js";
import { adminAuthMiddleware } from "../middleware/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the uploads directory exists before multer tries to write to it
const uploadsDir = path.join(__dirname, "../images/uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("[admin] Created uploads directory:", uploadsDir);
}

// Multer config: store uploaded menu images in backend/images/uploads/
const uploadStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, path.join(__dirname, "../images/uploads"));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
    cb(null, safeName);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});
import {
  getCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  getMenuItems,
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getTables,
  createTable,
  updateTable,
  deleteTable,
  getOrders,
  deleteAllOrders,
  deleteAllCompletedOrders,
  updateOrder,
  addOrderItems,
  removeOrderItems,
  deleteOrder,
  saveOrderSplits,
  getOrderSplits,
  createAdminOrder,
  getWaiters,
  getWaiterCalls,
  addWaiter,
  updateWaiter,
  deleteWaiter,
  getKitchenCredentials,
  updateKitchenPassword,
  getMenuVersion,
  incrementMenuVersion,
  getKotSections,
  setKotSections,
  getBillSections,
  setBillSections
} from "../services/adminService.js";
import {
  getOffers,
  addOffer,
  updateOffer,
  deleteOffer,
} from "../services/offerService.js";
import {
  getAllPrinterConfigs,
  savePrinterConfig,
  createPrintJob,
  getPrintJob,
  retryPrintJob,
  listFailedJobs,
} from "../services/printerService.js";

const router = express.Router();

// Handle CORS preflight requests
router.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-token,adminToken');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

router.use(adminAuthMiddleware);

// ==========================================
// IMAGE UPLOAD
// ==========================================
router.post("/upload-image", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      // Multer errors (file too large, wrong type, etc.)
      const msg = err.message || "File upload error";
      console.error("[upload-image] multer error:", msg);
      return res.status(400).json({ ok: false, error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No image file provided" });
    }
    const imageUrl = `/images/uploads/${req.file.filename}`;
    console.log("[upload-image] saved:", imageUrl);
    res.json(buildApiResponse({ imageUrl }));
  });
});

router.get("/categories", async (req, res, next) => {
  try {
    const categories = await getCategories(req.app.locals.db);
    res.json(buildApiResponse(categories));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.post("/categories", async (req, res, next) => {
  try {
    const { name, isActive, displayOrder } = req.body || {};
    if (!name) {
      return res.status(400).json({ ok: false, error: "Category name is required" });
    }
    const category = await addCategory(req.app.locals.db, { name, isActive, displayOrder });
    res.status(201).json(buildApiResponse(category));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/categories/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Category ID is required" });
    }
    const category = await updateCategory(req.app.locals.db, id, updates);
    res.json(buildApiResponse(category));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.delete("/categories/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: "Category ID is required" });
    }
    await deleteCategory(req.app.locals.db, id);
    res.json(buildApiResponse({ id }));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/menu", async (req, res, next) => {
  try {
    const menu = await getMenuItems(req.app.locals.db);
    res.json(buildApiResponse(menu));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.post("/menu", async (req, res, next) => {
  try {
    const item = req.body || {};
    if (!item.name) {
      return res.status(400).json({ ok: false, error: "Menu item name is required" });
    }
    const menuItem = await addMenuItem(req.app.locals.db, item);
    res.status(201).json(buildApiResponse(menuItem));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/menu/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const item = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Menu item ID is required" });
    }
    const updatedItem = await updateMenuItem(req.app.locals.db, id, item);
    res.json(buildApiResponse(updatedItem));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.delete("/menu/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: "Menu item ID is required" });
    }
    await deleteMenuItem(req.app.locals.db, id);
    res.json(buildApiResponse({ id }));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/tables", async (req, res, next) => {
  try {
    const tables = await getTables(req.app.locals.db);
    res.json(buildApiResponse(tables));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.post("/tables", async (req, res, next) => {
  try {
    const { area, areaLabel, tableNumber } = req.body || {};
    if (!area || tableNumber === undefined || tableNumber === null) {
      return res.status(400).json({ ok: false, error: "Table area and number are required" });
    }
    const table = await createTable(req.app.locals.db, { area, areaLabel, tableNumber });
    res.status(201).json(buildApiResponse(table));
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

router.delete("/tables/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: "Table ID is required" });
    }
    await deleteTable(req.app.locals.db, id);
    res.json(buildApiResponse({ id }));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/orders", async (req, res, next) => {
  try {
    const orders = await getOrders(req.app.locals.db);
    res.json(buildApiResponse(orders));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.post("/orders", async (req, res, next) => {
  try {
    const order = await createAdminOrder(req.app.locals.db, req.body || {});
    res.status(201).json(buildApiResponse(order));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

router.delete("/orders", async (req, res, next) => {
  try {
    const { completedOnly } = req.query;
    if (completedOnly === "true") {
      const result = await deleteAllCompletedOrders(req.app.locals.db);
      res.json(buildApiResponse(result));
    } else {
      const result = await deleteAllOrders(req.app.locals.db);
      res.json(buildApiResponse(result));
    }
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
    res.json(buildApiResponse(result));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// Add item(s) to an existing order ("Add Item" button on the order details drawer)
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

// Remove item(s) from an existing order ("Remove Item" button on the order details drawer)
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

// Cancel (permanently delete) a single order ("Cancel" button on the order details drawer)
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

router.post("/waiters", async (req, res, next) => {
  try {
    const waiter = req.body || {};
    if (!waiter.name) {
      return res.status(400).json({ ok: false, error: "Waiter name is required" });
    }
    const newWaiter = await addWaiter(req.app.locals.db, waiter);
    res.status(201).json(buildApiResponse(newWaiter));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/waiters/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const waiter = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Waiter ID is required" });
    }
    const updatedWaiter = await updateWaiter(req.app.locals.db, id, waiter);
    res.json(buildApiResponse(updatedWaiter));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.delete("/waiters/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: "Waiter ID is required" });
    }
    await deleteWaiter(req.app.locals.db, id);
    res.json(buildApiResponse({ id }));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/kitchen-credentials", async (req, res, next) => {
  try {
    const credentials = await getKitchenCredentials(req.app.locals.db);
    res.json(buildApiResponse(credentials));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/kitchen-credentials", async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ ok: false, error: "Kitchen password is required" });
    }
    const updated = await updateKitchenPassword(req.app.locals.db, password);
    res.json(buildApiResponse(updated));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/settings/menu-version", async (req, res, next) => {
  try {
    const version = await getMenuVersion(req.app.locals.db);
    res.json(buildApiResponse({ menuVersion: version }));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/settings/menu-version", async (req, res, next) => {
  try {
    const next = await incrementMenuVersion(req.app.locals.db);
    res.json(buildApiResponse({ menuVersion: next }));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/settings/kot-sections", async (req, res, next) => {
  try {
    const config = await getKotSections(req.app.locals.db);
    res.json(buildApiResponse(config));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/settings/kot-sections", async (req, res, next) => {
  try {
    const config = req.body || {};
    const updated = await setKotSections(req.app.locals.db, config);
    res.json(buildApiResponse(updated));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/settings/bill-sections", async (req, res, next) => {
  try {
    const config = await getBillSections(req.app.locals.db);
    res.json(buildApiResponse(config));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/settings/bill-sections", async (req, res, next) => {
  try {
    const config = req.body || {};
    const updated = await setBillSections(req.app.locals.db, config);
    res.json(buildApiResponse(updated));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.get("/offers", async (req, res, next) => {
  try {
    const offers = await getOffers(req.app.locals.db);
    res.json(buildApiResponse(offers));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.post("/offers", async (req, res, next) => {
  try {
    const { title, name, description, code, discountTag, isActive } = req.body || {};
    const normalizedTitle = title || name;
    if (!normalizedTitle) {
      return res.status(400).json({ ok: false, error: "Offer title is required" });
    }
    const offer = {
      title: normalizedTitle,
      description,
      code,
      discountTag,
      isActive,
    };
    const newOffer = await addOffer(req.app.locals.db, offer);
    res.status(201).json(buildApiResponse(newOffer));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.put("/offers/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const offer = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Offer ID is required" });
    }
    const normalizedOffer = {
      ...offer,
      title: offer.title ?? offer.name,
    };
    if (normalizedOffer.title === undefined && "name" in offer) {
      delete normalizedOffer.name;
    }
    const updatedOffer = await updateOffer(req.app.locals.db, id, normalizedOffer);
    res.json(buildApiResponse(updatedOffer));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

router.delete("/offers/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: "Offer ID is required" });
    }
    await deleteOffer(req.app.locals.db, id);
    res.json(buildApiResponse({ id }));
  } catch (err) {
    next(buildApiError(err.message, 500));
  }
});

// ==========================================
// PRINTING
//
// Admin configures the BILL and KOT printers ONCE here. Every print button
// -- in the Admin panel and on every waiter's phone -- reads these same
// rows and calls the exact same createPrintJob() function from
// services/printerService.js; nothing about the printer is duplicated
// between the two apps.
// ==========================================
router.get("/printers", async (req, res, next) => {
  try {
    const printers = await getAllPrinterConfigs(req.app.locals.db);
    res.json(buildApiResponse(printers));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

router.put("/printers/:type", async (req, res, next) => {
  try {
    const { type } = req.params;
    const settings = req.body || {};
    const printer = await savePrinterConfig(req.app.locals.db, type, settings);
    res.json(buildApiResponse(printer));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

// Test print -- goes through the exact same job queue/connector pipeline
// as a real print, but is flagged isTest so it never touches an order.
router.post("/printers/:type/test", async (req, res, next) => {
  try {
    const { type } = req.params;
    const job = await createPrintJob(req.app.locals.db, {
      type: type === "bill" ? "BILL" : "KOT",
      createdBy: "admin",
      isTest: true,
    });
    res.status(201).json(buildApiResponse(job));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

router.post("/print-jobs", async (req, res, next) => {
  try {
    const { orderId, type } = req.body || {};
    const job = await createPrintJob(req.app.locals.db, { orderId, type, createdBy: "admin" });
    res.status(201).json(buildApiResponse(job));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

router.get("/print-jobs/failed", async (req, res, next) => {
  try {
    const jobs = await listFailedJobs(req.app.locals.db);
    res.json(buildApiResponse(jobs));
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

router.post("/print-jobs/:id/retry", async (req, res, next) => {
  try {
    const job = await retryPrintJob(req.app.locals.db, req.params.id);
    res.json(buildApiResponse(job));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

export default router;
