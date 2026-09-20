/**
 * In-Memory RAM Cache for Restaurant Tables with Request Coalescing
 *
 * Performance Architecture:
 * 1. Dedicated in-memory storage for canonical restaurant tables in Node.js process RAM.
 * 2. Request coalescing (in-flight promise) to prevent cache stampedes:
 *    If 100 simultaneous requests arrive on a cold cache, exactly ONE MySQL query executes.
 * 3. Pure event-driven invalidation: ZERO TTL. Invalidation occurs immediately after
 *    successful table mutations in the backend database.
 * 4. Error safety: Failed DB loads clear the in-flight state in a finally block and
 *    do not poison the cache or trap waiting requests.
 * 5. Generation tracking: Prevents a slow query initiated prior to an invalidation from
 *    storing stale state.
 * 6. Contract & Sort preservation:
 *    - Customer endpoint receives 10 fields sorted by (area ASC, table_number ASC).
 *    - Staff/Admin endpoint receives 12 fields (including createdAt, updatedAt) sorted by (table_number ASC).
 * 7. Strictly isolated from menuCache, offersCache, and menuVersion state.
 */

function isSqliteDb(db) {
  return !!db && typeof db.all === "function" && typeof db.run === "function" && !db.collection;
}

// Canonical table cache: { data: Array<RawTableRow>, cachedAt: number } or null
let tableCache = null;

// In-flight loading promise for stampede coalescing
let inFlightTablesLoad = null;

// Generation counter incremented on every invalidation
let tableCacheGeneration = 0;

/**
 * Returns raw cached tables array if present, or null.
 */
export function getCachedTables() {
  return tableCache ? tableCache.data : null;
}

/**
 * Sets raw canonical tables array in RAM.
 */
export function setCachedTables(data) {
  tableCache = {
    data,
    cachedAt: Date.now(),
  };
}

/**
 * Immediately invalidates the table cache.
 * Increments generation to drop any currently in-flight DB queries.
 */
export function invalidateTableCache() {
  tableCacheGeneration++;
  tableCache = null;
  inFlightTablesLoad = null;
}

/**
 * Diagnostic stats for monitoring and testing.
 */
export function getTableCacheStats() {
  return {
    isCached: tableCache !== null,
    itemCount: tableCache ? tableCache.data.length : 0,
    cachedAt: tableCache ? tableCache.cachedAt : null,
    inFlight: inFlightTablesLoad !== null,
    generation: tableCacheGeneration,
  };
}

/**
 * Resets table cache state for testing simulations.
 */
export function resetTableCacheForTesting() {
  tableCache = null;
  inFlightTablesLoad = null;
  tableCacheGeneration = 0;
}

/**
 * Default database loader for canonical table rows.
 */
async function defaultCanonicalLoader(db) {
  if (isSqliteDb(db)) {
    return await db.all("SELECT * FROM tables ORDER BY table_number ASC");
  }

  // Firestore fallback if ever invoked in test/legacy mode
  const snapshot = await db.collection("restaurants").doc("rustic-charm").collection("tables").get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
}

/**
 * Core table cache fetcher with request coalescing.
 *
 * - Memory hit: returns canonical rows directly from RAM (0 queries).
 * - Simultaneous miss: returns the active in-flight Promise (1 query for all concurrent callers).
 * - Error: clears in-flight promise in finally block, allows next caller to retry cleanly.
 */
export async function getOrLoadTables(db, loaderFn = defaultCanonicalLoader) {
  // 1. Fast path: Memory Cache Hit (0 MySQL queries)
  if (tableCache !== null) {
    return tableCache.data;
  }

  // 2. Coalesce concurrent requests (Stampede Prevention)
  if (inFlightTablesLoad !== null) {
    return await inFlightTablesLoad;
  }

  // 3. Initiate single DB load
  const startGen = tableCacheGeneration;
  inFlightTablesLoad = (async () => {
    try {
      const data = await loaderFn(db);

      // Only commit if no invalidation happened during the query execution
      if (tableCacheGeneration === startGen) {
        setCachedTables(data);
      }
      return data;
    } finally {
      // Always reset in-flight promise whether resolved or rejected
      inFlightTablesLoad = null;
    }
  })();

  return await inFlightTablesLoad;
}

/**
 * Compares two table rows for Customer sorting: area ASC, table_number ASC.
 */
function compareCustomerTables(a, b) {
  const areaA = String(a.area || "");
  const areaB = String(b.area || "");
  const areaCmp = areaA.localeCompare(areaB);
  if (areaCmp !== 0) return areaCmp;
  const numA = Number(a.table_number ?? a.tableNumber ?? 0);
  const numB = Number(b.table_number ?? b.tableNumber ?? 0);
  return numA - numB;
}

/**
 * Compares two table rows for Staff/Admin sorting: table_number ASC.
 */
function compareAdminTables(a, b) {
  const numA = Number(a.table_number ?? a.tableNumber ?? 0);
  const numB = Number(b.table_number ?? b.tableNumber ?? 0);
  return numA - numB;
}

/**
 * Formats canonical rows into Customer API structure:
 * - 10 properties: id, tableKey, tableNumber, area, areaLabel, displayName, occupied, status, currentOrderId, currentSessionId
 * - Sorted by: area ASC, table_number ASC
 */
export function formatCustomerTables(rows) {
  if (!Array.isArray(rows)) return [];
  const sorted = [...rows].sort(compareCustomerTables);
  return sorted.map((row) => {
    const tableNumber = Number(row.table_number ?? row.tableNumber ?? 0);
    const area = row.area || "";
    const areaLabel = row.area_label || row.areaLabel || area;
    const displayName = row.display_name || row.displayName || `${areaLabel} - Table ${tableNumber}`;

    return {
      id: row.id,
      tableKey: row.table_key || row.tableKey || row.id,
      tableNumber,
      area,
      areaLabel,
      displayName,
      occupied: row.occupied === 1 || row.occupied === true || row.occupied === "1",
      status: row.status || "available",
      currentOrderId: row.current_order_id || row.currentOrderId || "",
      currentSessionId: row.current_session_id || row.currentSessionId || "",
    };
  });
}

/**
 * Formats canonical rows into Staff/Admin API structure:
 * - 12 properties: id, tableKey, tableNumber, area, areaLabel, displayName, occupied, status, currentOrderId, currentSessionId, createdAt, updatedAt
 * - Sorted by: table_number ASC
 */
export function formatAdminTables(rows) {
  if (!Array.isArray(rows)) return [];
  const sorted = [...rows].sort(compareAdminTables);
  return sorted.map((row) => {
    const tableNumber = Number(row.table_number ?? row.tableNumber ?? 0);
    const area = row.area || "";
    const areaLabel = row.area_label || row.areaLabel || area;
    const displayName = row.display_name || row.displayName || `${areaLabel} - Table ${tableNumber}`;

    return {
      id: row.id,
      tableKey: row.table_key || row.tableKey || row.id,
      tableNumber,
      area,
      areaLabel,
      displayName,
      occupied: row.occupied === 1 || row.occupied === true || row.occupied === "1" || row.occupied === "true",
      status: row.status || "available",
      currentOrderId: row.current_order_id || row.currentOrderId || "",
      currentSessionId: row.current_session_id || row.currentSessionId || "",
      createdAt: row.created_at ?? row.createdAt ?? null,
      updatedAt: row.updated_at ?? row.updatedAt ?? null,
    };
  });
}

/**
 * Returns customer tables from cache (or loads from DB on miss).
 */
export async function getCustomerTables(db, loaderFn = defaultCanonicalLoader) {
  const canonicalRows = await getOrLoadTables(db, loaderFn);
  return formatCustomerTables(canonicalRows);
}

/**
 * Returns staff/admin tables from cache (or loads from DB on miss).
 */
export async function getAdminTables(db, loaderFn = defaultCanonicalLoader) {
  const canonicalRows = await getOrLoadTables(db, loaderFn);
  return formatAdminTables(canonicalRows);
}
