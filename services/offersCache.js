/**
 * In-Memory RAM Cache for Customer Offers with Stampede Prevention
 *
 * Features:
 * 1. Dedicated in-memory storage for active customer offers
 * 2. Request coalescing (in-flight promise) to prevent cache stampedes
 * 3. Invalidation triggered exclusively on successful admin mutations
 * 4. Error safety: preserves existing cache on failure and cleans up in-flight promises
 * 5. Generation tracking to prevent stale DB queries from committing after an invalidation
 * 6. Completely isolated from menuCache and menuVersion
 */

// Cached data structure: { data: Array<Offer>, cachedAt: number } or null
let offersCache = null;

// In-flight loading promise to coalesce simultaneous requests
let inFlightOffersLoad = null;

// Generation counter incremented on every invalidation
let offersCacheGeneration = 0;

/**
 * Returns cached customer offers array if present, or null.
 */
export function getCachedOffers() {
  return offersCache ? offersCache.data : null;
}

/**
 * Sets the cached customer offers in memory.
 */
export function setCachedOffers(data) {
  offersCache = {
    data,
    cachedAt: Date.now(),
  };
}

/**
 * Invalidates the offers cache immediately.
 * Increments generation to discard any currently in-flight DB responses.
 */
export function invalidateOffersCache() {
  offersCacheGeneration++;
  offersCache = null;
  inFlightOffersLoad = null;
}

/**
 * Returns cache diagnostics (useful for testing and monitoring).
 */
export function getOffersCacheStats() {
  return {
    isCached: offersCache !== null,
    itemCount: offersCache ? offersCache.data.length : 0,
    cachedAt: offersCache ? offersCache.cachedAt : null,
    inFlight: inFlightOffersLoad !== null,
    generation: offersCacheGeneration,
  };
}

/**
 * Resets cache state for test simulations.
 */
export function resetOffersCacheForTesting() {
  offersCache = null;
  inFlightOffersLoad = null;
  offersCacheGeneration = 0;
}

/**
 * Core cache access function with request coalescing.
 *
 * - If cached: returns cached array immediately (< 1ms, 0 MySQL queries).
 * - If already loading: waits for existing in-flight Promise (preventing stampedes).
 * - If not cached: initiates a single DB load, caches active offers, and returns them.
 * - On error: cleans up in-flight state and allows retries without corrupting cache.
 */
export async function getOrLoadOffers(db, loaderFn) {
  // 1. Fast path: Memory Cache Hit (0 MySQL queries)
  if (offersCache !== null) {
    return offersCache.data;
  }

  // 2. Coalesce concurrent requests (Stampede Prevention)
  if (inFlightOffersLoad !== null) {
    return await inFlightOffersLoad;
  }

  // 3. Initiate single DB load
  const startGen = offersCacheGeneration;
  inFlightOffersLoad = (async () => {
    try {
      const data = await loaderFn(db);

      // Only commit if no invalidation happened during the query
      if (offersCacheGeneration === startGen) {
        setCachedOffers(data);
      }
      return data;
    } finally {
      inFlightOffersLoad = null;
    }
  })();

  try {
    return await inFlightOffersLoad;
  } catch (err) {
    // In-flight state was cleaned in finally block; propagate error to caller
    throw err;
  }
}
