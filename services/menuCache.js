/**
 * In-Memory RAM Cache for Menu Responses & Menu Version with Language Support & Stampede Prevention
 *
 * Features:
 * 1. Language-partitioned cache (menuCache[lang] -> response array)
 * 2. In-memory menu version tracking (currentMenuVersion) initialized from MySQL ONCE on startup
 * 3. Request coalescing (inFlightLoads[lang] -> Promise) to prevent cache stampedes
 * 4. Generation tracking to prevent stale in-flight loads from overwriting fresh invalidations
 * 5. Monotonic version updating on successful DB mutations
 * 6. Zero external dependencies (pure Node.js RAM)
 * 7. Bounded memory with LRU-style eviction for safety
 */

const MAX_CACHE_ENTRIES = 50;

// Cache storage: normalizedLang -> Array of menu item objects
const menuCache = new Map();

// In-flight load promises: normalizedLang -> Promise<Array>
const inFlightLoads = new Map();

// Generation counter incremented on every invalidation to discard stale in-flight DB results
let cacheGeneration = 0;

// In-memory menu version initialized ONCE from MySQL at startup
let currentMenuVersion = null;

/**
 * Normalizes input language string into a canonical language code.
 * Matches existing adminService/translations mapping.
 */
export function normalizeMenuLang(lang) {
  if (!lang || lang === "undefined" || lang === "null") return "__all__";
  const str = String(lang).toLowerCase().trim();
  if (!str || str === "undefined" || str === "null") return "__all__";

  const langMap = {
    english: "en",
    russian: "ru",
    german: "de",
    spanish: "es",
    kazakh: "kk",
    hebrew: "he",
    japanese: "ja",
    korean: "ko",
    en: "en",
    ru: "ru",
    de: "de",
    es: "es",
    kk: "kk",
    he: "he",
    ja: "ja",
    ko: "ko",
  };

  return langMap[str] || str;
}

/**
 * Retrieves the cached menu response for a language if present.
 */
export function getCachedMenu(lang) {
  const key = normalizeMenuLang(lang);
  return menuCache.get(key) || null;
}

/**
 * Stores the menu response in memory for a language.
 */
export function setCachedMenu(lang, data) {
  const key = normalizeMenuLang(lang);
  if (menuCache.size >= MAX_CACHE_ENTRIES && !menuCache.has(key)) {
    // Evict oldest entry if limit reached
    const oldestKey = menuCache.keys().next().value;
    if (oldestKey) menuCache.delete(oldestKey);
  }
  menuCache.set(key, data);
}

/**
 * Initializes currentMenuVersion from MySQL ONCE on backend startup.
 */
export async function initMenuVersion(db) {
  if (!db || typeof db.get !== "function") {
    throw new Error("[menuCache] Database connection required to initialize menu version");
  }
  const row = await db.get("SELECT value FROM restaurant_settings WHERE `key` = 'menu_version' LIMIT 1");
  const ver = row && row.value ? Number(row.value) : 1;
  currentMenuVersion = ver;
  return currentMenuVersion;
}

/**
 * Returns the current in-memory menu version.
 */
export function getCurrentMenuVersion() {
  return currentMenuVersion;
}

/**
 * Updates the in-memory menu version monotonically after a successful database update.
 * Using Math.max guarantees an older concurrent operation cannot overwrite a newer version.
 */
export function setCurrentMenuVersion(newVersion) {
  const num = Number(newVersion);
  if (!isNaN(num)) {
    currentMenuVersion = currentMenuVersion !== null ? Math.max(currentMenuVersion, num) : num;
  }
  return currentMenuVersion;
}

/**
 * Testing helper to reset in-memory version state.
 */
export function resetMenuVersionForTesting() {
  currentMenuVersion = null;
}

/**
 * Invalidates ALL language-specific menu caches immediately.
 * Increments generation to ensure any currently in-flight DB loads do not commit stale data.
 */
export function invalidateMenuCache() {
  cacheGeneration++;
  menuCache.clear();
  inFlightLoads.clear();
}

/**
 * Returns cache diagnostics (useful for testing and monitoring).
 */
export function getMenuCacheStats() {
  return {
    cachedLanguages: Array.from(menuCache.keys()),
    inFlightCount: inFlightLoads.size,
    cacheGeneration,
    entryCount: menuCache.size,
    currentMenuVersion,
  };
}

/**
 * Core cache access function with request coalescing.
 *
 * - If cached: returns cached array immediately (< 1ms, 0 MySQL queries).
 * - If already loading: waits for the existing in-flight Promise (preventing stampedes).
 * - If not cached: initiates a single DB load, caches the result, and returns it.
 * - On error: cleans up in-flight state and allows retries without corrupting cache.
 */
export async function getOrLoadMenu(db, lang, loaderFn) {
  const key = normalizeMenuLang(lang);

  // 1. Fast path: Memory Cache Hit (0 MySQL queries)
  if (menuCache.has(key)) {
    return menuCache.get(key);
  }

  // 2. Coalesce concurrent requests (Cache Stampede Prevention)
  // If another request is currently fetching this language from MySQL, wait for its result.
  if (inFlightLoads.has(key)) {
    return await inFlightLoads.get(key);
  }

  // 3. Initiate single DB load for this language
  const startGen = cacheGeneration;
  const loadPromise = (async () => {
    try {
      // Pass null if key is "__all__" so loaderFn uses default full translation behavior
      const data = await loaderFn(db, key === "__all__" ? null : key);

      // Only commit to RAM cache if no invalidation happened during the query
      if (cacheGeneration === startGen) {
        setCachedMenu(key, data);
      }
      return data;
    } finally {
      // Guaranteed cleanup of in-flight promise whether successful or failed
      inFlightLoads.delete(key);
    }
  })();

  inFlightLoads.set(key, loadPromise);

  try {
    return await loadPromise;
  } catch (err) {
    // Ensure cache is completely clean on failure
    menuCache.delete(key);
    throw err;
  }
}

/**
 * Generates an HTTP ETag based on the menu version and language.
 * Format: W/"menu-v<version>-<lang>"
 * Operates purely in memory with 0 database queries.
 */
export function getMenuEtag(lang, version) {
  const v = version !== undefined && version !== null ? version : (getCurrentMenuVersion() || 1);
  const normLang = normalizeMenuLang(lang);
  return `W/"menu-v${v}-${normLang}"`;
}

/**
 * Checks whether an incoming If-None-Match header matches the current ETag.
 * Standard-compliant: supports weak (W/) and strong ETags, quote variations,
 * comma-separated tag lists, and wildcard (*).
 */
export function matchesIfNoneMatch(ifNoneMatchHeader, currentEtag) {
  if (!ifNoneMatchHeader || !currentEtag) return false;
  if (ifNoneMatchHeader.trim() === "*") return true;

  const normalize = (tag) => tag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const target = normalize(currentEtag);

  const tags = ifNoneMatchHeader.split(",").map(normalize);
  return tags.includes(target);
}
