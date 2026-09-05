import express from "express";
import { buildApiResponse, buildApiError } from "../services/apiService.js";
import {
  listCustomerTables,
  getSessionInfo,
  createOrder,
  getOrdersBySession,
  getOrderById,
  createWaiterCall,
  requestBill,
} from "../services/customerService.js";
import { createPrintJob } from "../services/printerService.js";

const router = express.Router();

router.get("/tables", async (req, res, next) => {
  try {
    const tables = await listCustomerTables(req.app.locals.db);
    res.json(buildApiResponse(tables));
  } catch (err) {
    next(buildApiError(err.message || "Unable to load tables", err.status || 500));
  }
});

router.get("/session", async (req, res, next) => {
  try {
    const { sessionId, tableReference } = req.query;
    if (!sessionId || !tableReference) {
      return next(buildApiError("sessionId and tableReference are required", 400));
    }

    const data = await getSessionInfo(req.app.locals.db, String(sessionId), String(tableReference));
    res.json(buildApiResponse(data));
  } catch (err) {
    next(buildApiError(err.message || "Unable to load session", err.status || 500));
  }
});

router.post("/orders", async (req, res, next) => {
  try {
    const { tableReference, cart, total, sessionId, customerName, customerPhone } = req.body;
    const result = await createOrder(
      req.app.locals.db,
      tableReference,
      cart,
      total,
      sessionId,
      customerName,
      customerPhone
    );

    try {
      await createPrintJob(req.app.locals.db, {
        orderId: result.id,
        type: "KOT",
        createdBy: "Customer",
      });
    } catch (printErr) {
      console.warn("KOT auto-print on customer order skipped/failed:", printErr?.message || printErr);
    }

    res.status(201).json(buildApiResponse(result));
  } catch (err) {
    next(buildApiError(err.message || "Unable to create order", err.status || 500));
  }
});

router.get("/orders", async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return next(buildApiError("sessionId is required", 400));
    }

    const orders = await getOrdersBySession(req.app.locals.db, String(sessionId));
    res.json(buildApiResponse(orders));
  } catch (err) {
    next(buildApiError(err.message || "Unable to load orders", err.status || 500));
  }
});

router.get("/order-status", async (req, res, next) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return next(buildApiError("orderId is required", 400));
    }

    const order = await getOrderById(req.app.locals.db, String(orderId));
    res.json(buildApiResponse(order));
  } catch (err) {
    next(buildApiError(err.message || "Unable to load order status", err.status || 500));
  }
});

router.post("/waiter-calls", async (req, res, next) => {
  try {
    const { tableReference, sessionId, customerName, customerPhone, orderId } = req.body;
    const result = await createWaiterCall(
      req.app.locals.db,
      tableReference,
      sessionId,
      customerName,
      customerPhone,
      orderId
    );
    res.status(201).json(buildApiResponse(result));
  } catch (err) {
    next(buildApiError(err.message || "Unable to create waiter call", err.status || 500));
  }
});

router.post("/request-bill", async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return next(buildApiError("orderId is required", 400));
    }
    const result = await requestBill(req.app.locals.db, String(orderId));
    res.json(buildApiResponse(result));
  } catch (err) {
    next(buildApiError(err.message || "Unable to request bill", err.status || 500));
  }
});

export default router;
