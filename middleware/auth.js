import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const isProductionEnv = process.env.NODE_ENV === "production";
// In production, there is NO hardcoded fallback token — ADMIN_API_TOKEN must be set
// in the environment, or local token-based admin auth is disabled entirely.
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || (isProductionEnv ? null : "rustic-charm-admin-token");
if (isProductionEnv && !process.env.ADMIN_API_TOKEN) {
  console.error("[auth] FATAL: ADMIN_API_TOKEN is not set. The local admin-token auth path is disabled until this environment variable is configured.");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serviceAccountPath = path.join(__dirname, "..", "serviceAccountKey.json");

let firebaseAdminApp;
let firebaseAdminModule = null; // lazily loaded

async function loadFirebaseAdmin() {
  if (firebaseAdminModule) return firebaseAdminModule;
  try {
    const mod = await import("firebase-admin");
    firebaseAdminModule = mod.default ?? mod;
    return firebaseAdminModule;
  } catch (e) {
    console.warn("[auth] firebase-admin not installed; Firebase token verification disabled. Local token auth still works.");
    return null;
  }
}

async function ensureFirebaseAdmin() {
  if (firebaseAdminApp) return firebaseAdminApp;

  const admin = await loadFirebaseAdmin();
  if (!admin) return null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      firebaseAdminApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      return firebaseAdminApp;
    } catch (err) {
      console.warn("Failed to initialize firebase-admin from FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
      return null;
    }
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      if (typeof admin.initializeApp === "function") {
        firebaseAdminApp = admin.initializeApp();
        return firebaseAdminApp;
      }
    } catch (err) {
      console.warn("Failed to initialize firebase-admin from env:", err);
      return null;
    }
  }

  if (fs.existsSync(serviceAccountPath)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));
      if (admin.credential && typeof admin.credential.cert === "function") {
        firebaseAdminApp = admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        return firebaseAdminApp;
      }
      console.warn("firebase-admin credential.cert is not available; skipping Firebase admin init.");
      return null;
    } catch (err) {
      console.warn("Failed to initialize firebase-admin from serviceAccountKey.json:", err);
      return null;
    }
  }

  return null;
}

function verifyLocalAdminToken(token) {
  if (!token) return null;
  return token === ADMIN_TOKEN ? { admin: true, role: "admin", provider: "local" } : null;
}

async function verifyFirebaseAdminToken(token) {
  if (!token) return null;
  const app = await ensureFirebaseAdmin();

  if (app) {
    try {
      const admin = firebaseAdminModule;
      const decodedToken = await admin.auth(app).verifyIdToken(token);
      if (decodedToken.admin || decodedToken.role === "admin") {
        return { admin: true, role: "admin", provider: "firebase", uid: decodedToken.uid };
      }
    } catch (err) {
      // If verification failed, fall through to a non-verified decode only in dev
      try {
        if (process.env.NODE_ENV !== "production") {
          const parts = String(token).split(".");
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
            if (payload && (payload.admin || payload.role === "admin")) {
              console.warn("verifyFirebaseAdminToken: firebase.verifyIdToken failed; using UNSAFE JWT decode fallback for dev");
              return { admin: true, role: "admin", provider: "jwt-unsafe", uid: payload.uid || null };
            }
          }
        }
      } catch (e) {
        // ignore decode errors
      }
      return null;
    }
  }

  // If firebase-admin is not initialized, allow a development-only fallback
  // that decodes the JWT payload WITHOUT verifying the signature. This is
  // intentionally only for non-production development convenience when the
  // service account/credentials are not present. It does NOT run in production.
  try {
    if (process.env.NODE_ENV !== "production") {
      const parts = String(token).split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        if (payload && (payload.admin || payload.role === "admin")) {
          console.warn("verifyFirebaseAdminToken: using UNSAFE JWT decode fallback for dev (firebase-admin not configured)");
          return { admin: true, role: "admin", provider: "jwt-unsafe", uid: payload.uid || null };
        }
      }
    }
  } catch (err) {
    // ignore decode errors
  }

  return null;
}

async function adminAuthMiddleware(req, res, next) {
  // Allow CORS preflight requests to pass through without authentication
  if (req.method === 'OPTIONS') {
    return next();
  }

  // Accept token from multiple places to be robust in dev/proxy setups
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  if (!token && req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'];
  }

  if (!token && req.query && req.query.adminToken) {
    token = req.query.adminToken;
  }

  if (!token && req.body && req.body.adminToken) {
    token = req.body.adminToken;
  }
  let decoded = verifyLocalAdminToken(token);

  if (!decoded) {
    decoded = await verifyFirebaseAdminToken(token);
  }

  if (!decoded) {
    return res.status(401).json({ ok: false, error: "Unauthorized or expired admin token" });
  }

  req.admin = decoded;
  next();
}

export { adminAuthMiddleware, verifyLocalAdminToken as verifyFirebaseAdminToken };

