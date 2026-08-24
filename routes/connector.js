import express from "express";
import { buildApiResponse, buildApiError } from "../services/apiService.js";
import { claimPendingJobs, reportPrintJobResult } from "../services/printerService.js";

// This router is talked to ONLY by the one restaurant-side print connector
// background service -- never by a waiter or admin browser. It is
// authenticated with a static shared secret (CONNECTOR_API_KEY), not an
// admin browser session, because the connector is a long-running unattended
// process on the restaurant's own PC, not a person logging in.
//
// Critically, every request here is initiated BY the connector (it polls
// outbound over HTTPS). The backend never tries to reach into the
// restaurant's LAN, which is what makes this work despite the printer
// sitting behind the restaurant's router with no port forwarding.

const isProductionEnv = process.env.NODE_ENV === "production";
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY || (isProductionEnv ? null : "rustic-charm-connector-key");
if (isProductionEnv && !process.env.CONNECTOR_API_KEY) {
  console.error("[connector] FATAL: CONNECTOR_API_KEY is not set. The print connector cannot authenticate until this environment variable is configured.");
}

const router = express.Router();

router.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-connector-key");
  res.sendStatus(200);
});

function requireConnectorKey(req, res, next) {
  const key = req.headers["x-connector-key"];
  if (!CONNECTOR_API_KEY || !key || key !== CONNECTOR_API_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid or missing connector key" });
  }
  next();
}

router.use(requireConnectorKey);

// The connector polls this on an interval. Every poll -- even one that
// returns no jobs -- counts as a heartbeat, which is what lets Admin show
// an accurate READY/OFFLINE status instead of just "configured".
router.get("/jobs", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 5;
    const jobs = await claimPendingJobs(req.app.locals.db, limit);
    res.json(buildApiResponse(jobs));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

router.post("/jobs/:id/result", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, errorMessage } = req.body || {};
    if (!["PRINTED", "FAILED"].includes(status)) {
      return res.status(400).json({ ok: false, error: "status must be PRINTED or FAILED" });
    }
    const job = await reportPrintJobResult(req.app.locals.db, id, { status, errorMessage });
    res.json(buildApiResponse(job));
  } catch (err) {
    next(buildApiError(err.message, err.status || 500));
  }
});

export default router;
