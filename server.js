import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import sqlite3 from "sqlite3";
import { openDatabase } from "./config/database.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { adminAuthMiddleware } from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import customerRouter from "./routes/customer.js";
import adminRouter from "./routes/admin.js";
import { getCategories, getMenuItems, addMenuItem, deleteMenuItem, getOrders } from "./services/adminService.js";
import { createOrder } from "./services/customerService.js";
import { getOffers as getAdminOffers, addOffer as addAdminOffer, updateOffer as updateAdminOffer, deleteOffer as deleteAdminOffer } from "./services/offerService.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Offer storage helper is moved to a shared service module.

const app = express();
const PORT = process.env.PORT || 5000;
const defaultCorsOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://poetic-fox-ac184c.netlify.app",
  "https://rusticcharmfrontend.netlify.app",
  "https://idyllic-caramel-f532c6.netlify.app/",
  "https://rustic-charm.in",
  "https://www.rustic-charm.in"

];
const configuredCorsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOrigins = [...new Set([...defaultCorsOrigins, ...configuredCorsOrigins])];

const sqliteDb = openDatabase();
app.locals.sqliteDb = sqliteDb;

const offersDbPath = path.join(__dirname, "offers.db");
let offersDb;

function openOffersDb() {
  return new Promise((resolve, reject) => {
    if (offersDb) return resolve(offersDb);
    offersDb = new sqlite3.Database(offersDbPath, (err) => {
      if (err) return reject(err);
      resolve(offersDb);
    });
  });
}

function queryOffersDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    openOffersDb()
      .then((db) => {
        db.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        });
      })
      .catch(reject);
  });
}

function executeOffersDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    openOffersDb()
      .then((db) => {
        db.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve({ changes: this.changes, lastID: this.lastID });
        });
      })
      .catch(reject);
  });
}

async function ensureOffersDbReady() {
  await openOffersDb();
  await executeOffersDb(
    `CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      code TEXT,
      discountTag TEXT,
      isActive INTEGER,
      createdAt TEXT
    )`
  );
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || corsOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'adminToken'],
  optionsSuccessStatus: 200
}));
app.use(express.json());

// ==========================================
// BASIC RATE LIMITING (in-memory, per IP)
// ==========================================
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 120; // max requests per IP per window
const rateLimitBuckets = new Map();

app.use((req, res, next) => {
  const key = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(key, { windowStart: now, count: 1 });
    return next();
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ ok: false, error: "Too many requests. Please slow down and try again shortly." });
  }

  next();
});

// Periodically clear stale buckets so memory usage doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitBuckets.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref?.();

app.locals.db = sqliteDb;
console.log("🗄️ SQLite database initialized for the backend data layer");

// Initialize Gemini AI Client (disabled for stability)
let ai = null;
if (process.env.GEMINI_API_KEY) {
  console.warn("⚠️ Gemini AI client support is disabled in this deployment.");
}

// ==========================================
// ADMIN AUTHENTICATION (SECURE TOKEN-BASED)
// ==========================================
const isProductionEnv = process.env.NODE_ENV === "production";
if (!isProductionEnv) {
  console.warn("\u26a0\ufe0f  NODE_ENV is not set to 'production'. Development-only fallbacks (default admin credentials, unsigned JWT decode in auth.js) are ACTIVE. Set NODE_ENV=production before deploying.");
}
// In production, there is NO hardcoded fallback — these must be set in the environment.
const ADMIN_USER = process.env.ADMIN_USERNAME || (isProductionEnv ? undefined : "admin");
const ADMIN_PASS = process.env.ADMIN_PASSWORD || (isProductionEnv ? undefined : "admin111");
if (isProductionEnv && (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD)) {
  console.error("[server] FATAL: ADMIN_USERNAME/ADMIN_PASSWORD are not set in the production environment.");
}


// Serve food images as static assets
app.use('/images', express.static(path.join(__dirname, 'images')));

// Serve rating QR code image
app.get('/api/rating-qr.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'rating', 'rating.png'));
});

// API boundary mounts for future operations
app.use("/api/health", healthRouter);
app.use("/api/customer", customerRouter);
app.use("/api/admin", adminRouter);

// ==========================================
// API ROUTES
// ==========================================

// Menu Endpoints
app.get("/api/menu", async (req, res) => {
  try {
    const items = await getMenuItems(sqliteDb);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/menu", async (req, res) => {
  try {
    const item = await addMenuItem(sqliteDb, req.body || {});
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/menu/:id", async (req, res) => {
  try {
    await deleteMenuItem(sqliteDb, req.params.id);
    res.json({ success: true, message: `Menu item ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Categories Endpoints
app.get("/api/categories", async (req, res) => {
  try {
    const categories = await getCategories(sqliteDb);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SQLite Offers Endpoints
app.get("/api/offers", async (req, res) => {
  try {
    const offers = await getAdminOffers(sqliteDb);
    res.json(offers.filter((offer) => offer.isActive !== false));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/offers", async (req, res) => {
  try {
    const { title, description, code, discountTag, isActive } = req.body || {};
    if (!title) {
      return res.status(400).json({ error: "Offer title is required" });
    }

    const newOffer = await addAdminOffer(sqliteDb, {
      title,
      description,
      code,
      discountTag,
      isActive,
    });

    res.status(201).json(newOffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put("/api/offers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, code, discountTag, isActive } = req.body || {};

    const updatedOffer = await updateAdminOffer(sqliteDb, id, {
      title,
      description,
      code,
      discountTag,
      isActive,
    });

    res.json(updatedOffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/offers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteAdminOffer(sqliteDb, id);
    res.json({ success: true, changes: result ? 1 : 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Orders Endpoints
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await getOrders(sqliteDb);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const { tableNumber, tableReference, cart, total, sessionId, customerName, customerPhone } = req.body || {};
    const reference = tableReference || tableNumber;
    if (!reference) {
      return res.status(400).json({ error: "A valid table reference is required." });
    }

    const result = await createOrder(
      sqliteDb,
      reference,
      Array.isArray(cart) ? cart : [],
      Number(total) || 0,
      sessionId,
      customerName,
      customerPhone
    );

    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Menu Translation Endpoint
app.post("/api/translate-menu", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: "Gemini AI is not configured" });
    }
    const { items, languages = ["Russian", "German", "Spanish", "Kazakh", "Hebrew", "Japanese", "Korean"] } = req.body;
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: "Invalid items array provided" });
    }

    const promptLines = items.map((item, idx) => {
      const name = typeof item.name === "object" ? item.name.English : item.name;
      const desc = typeof item.description === "object" ? item.description.English : item.description || "";
      return `Item ${idx + 1}::\nName: ${name}\nDescription: ${desc}\n`;
    });

    const prompt = `You are a professional restaurant menu translator. Translate the following food names and descriptions into the languages: ${languages.join(", ")}.
Return ONLY valid JSON array matching the order of items. Each element should be an object with two keys: "name" and "description", each containing a map of language->translation.
${promptLines.join("\n")}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    let text = response.text?.trim() || "";
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const translations = JSON.parse(text);

    res.json({ translations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Rustic Charm Backend Server running on http://localhost:${PORT}`);
});
