import crypto from "crypto";
import {
  getOrLoadOffers,
  invalidateOffersCache,
  getCachedOffers,
  getOffersCacheStats,
} from "./offersCache.js";

function isSqliteDb(db) {
  return !!db && typeof db.all === "function" && typeof db.run === "function" && !db.collection;
}

function offersCollection(db) {
  return db.collection("restaurants").doc("rustic-charm").collection("offers");
}

/**
 * Direct database loader for all offers.
 */
export async function fetchOffersFromDb(db) {
  if (!db) throw new Error("Database not initialized");

  if (isSqliteDb(db)) {
    const rows = await db.all("SELECT * FROM offers ORDER BY created_at DESC");
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description || "",
      code: row.code || "",
      discountTag: row.discount_tag || "",
      isActive: row.is_active === 1 || row.is_active === true || row.is_active === "1",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  const snapshot = await offersCollection(db).orderBy("createdAt", "desc").get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
}

/**
 * Customer-facing active offers with in-memory caching and request coalescing.
 * Returns only active offers (isActive !== false), matching the exact API contract.
 */
export async function getActiveOffers(db, options = {}) {
  if (options && options.skipCache) {
    const all = await fetchOffersFromDb(db);
    return all.filter((offer) => offer.isActive !== false);
  }

  return getOrLoadOffers(db, async (dbConn) => {
    const all = await fetchOffersFromDb(dbConn);
    return all.filter((offer) => offer.isActive !== false);
  });
}

/**
 * Returns all offers (active and inactive), preserving backward compatibility for admin.
 */
export async function getOffers(db) {
  return fetchOffersFromDb(db);
}

export async function addOffer(db, offer) {
  if (!db) throw new Error("Database not initialized");
  if (!offer || !offer.title) throw new Error("Offer title is required");

  if (isSqliteDb(db)) {
    const id = offer.id || crypto.randomUUID();
    const data = {
      id,
      title: offer.title || "",
      description: offer.description || "",
      code: offer.code || "",
      discount_tag: offer.discountTag || "",
      is_active: offer.isActive === false ? 0 : 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await db.run(
      "INSERT INTO offers (id, title, description, code, discount_tag, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [data.id, data.title, data.description, data.code, data.discount_tag, data.is_active, data.created_at, data.updated_at]
    );

    // Invalidate customer offers cache after successful DB commit
    invalidateOffersCache();

    return { ...data, discountTag: data.discount_tag, isActive: data.is_active === 1, createdAt: data.created_at, updatedAt: data.updated_at };
  }

  const data = {
    title: offer.title || "",
    description: offer.description || "",
    code: offer.code || "",
    discountTag: offer.discountTag || "",
    isActive: offer.isActive !== false,
    createdAt: new Date().toISOString(),
  };

  const docRef = await offersCollection(db).add(data);

  // Invalidate customer offers cache after successful DB commit
  invalidateOffersCache();

  return { id: docRef.id, ...data };
}

export async function updateOffer(db, id, updates) {
  if (!db) throw new Error("Database not initialized");
  if (!id) throw new Error("Offer ID is required");
  if (!updates || Object.keys(updates).length === 0) {
    throw new Error("Offer update payload is required");
  }

  if (isSqliteDb(db)) {
    const payload = {
      title: updates.title,
      description: updates.description,
      code: updates.code,
      discount_tag: updates.discountTag,
      is_active: updates.isActive,
      updated_at: new Date().toISOString(),
    };
    const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
    if (!entries.length) return { id };
    const clauses = entries.map(([key]) => `${key} = ?`).join(", ");
    const params = entries.map(([, value]) => value);
    params.push(id);
    await db.run(`UPDATE offers SET ${clauses} WHERE id = ?`, params);

    // Invalidate customer offers cache after successful DB commit
    invalidateOffersCache();

    return { id, ...updates };
  }

  const allowedUpdates = {
    title: updates.title,
    description: updates.description,
    code: updates.code,
    discountTag: updates.discountTag,
    isActive: updates.isActive,
  };

  const payload = {};
  for (const key of Object.keys(allowedUpdates)) {
    if (allowedUpdates[key] !== undefined) {
      payload[key] = allowedUpdates[key];
    }
  }

  await offersCollection(db).doc(id).update(payload);

  // Invalidate customer offers cache after successful DB commit
  invalidateOffersCache();

  return { id, ...payload };
}

export async function deleteOffer(db, id) {
  if (!db) throw new Error("Database not initialized");
  if (!id) throw new Error("Offer ID is required");

  if (isSqliteDb(db)) {
    await db.run("DELETE FROM offers WHERE id = ?", [id]);

    // Invalidate customer offers cache after successful DB commit
    invalidateOffersCache();

    return { id };
  }

  await offersCollection(db).doc(id).delete();

  // Invalidate customer offers cache after successful DB commit
  invalidateOffersCache();

  return { id };
}

export { invalidateOffersCache, getCachedOffers, getOffersCacheStats };
