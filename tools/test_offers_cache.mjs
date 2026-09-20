import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../config/database.js';
import { getActiveOffers, addOffer, updateOffer, deleteOffer, invalidateOffersCache } from '../services/offerService.js';
import { getOffersCacheStats, resetOffersCacheForTesting, getOrLoadOffers } from '../services/offersCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function run() {
  console.log('=== RUNNING CUSTOMER OFFERS CACHE VERIFICATION ===\n');

  const db = openDatabase();

  // Test 0: Reset & Verify Initial State
  resetOffersCacheForTesting();
  let stats = getOffersCacheStats();
  console.log('Initial offers cache stats:', stats);
  if (stats.isCached) throw new Error('Offers cache should start unpopulated');

  // Test A: Cold Offers Request (1 MySQL Load -> Cache Populated)
  console.log('\n--- Test A: Cold Offers Request (First Load) ---');
  let dbQueries = 0;
  const instrumentedDb = {
    ...db,
    all: async (...args) => {
      dbQueries++;
      return db.all(...args);
    },
    run: async (...args) => {
      return db.run(...args);
    },
  };

  const t0 = performance.now();
  const offers1 = await getActiveOffers(instrumentedDb);
  const t1 = performance.now();
  console.log(`Loaded ${offers1.length} active offers in ${(t1 - t0).toFixed(2)} ms.`);
  console.log(`MySQL queries executed on cold load: ${dbQueries}`);
  if (dbQueries !== 1) throw new Error(`Expected 1 MySQL query on cold load, got ${dbQueries}`);

  stats = getOffersCacheStats();
  console.log('Cache stats after first load:', stats);
  if (!stats.isCached || stats.itemCount !== offers1.length) {
    throw new Error('Cache was not properly populated after first load');
  }
  console.log('✓ Test A passed: Cold request loaded from MySQL and populated RAM cache.');

  // Test B: 100 Simultaneous Cold Requests (Cache Stampede Prevention)
  console.log('\n--- Test B: 100 Simultaneous Requests on Cold Cache (Stampede Prevention) ---');
  resetOffersCacheForTesting();
  let stampedeDbQueries = 0;
  const stampedeMockLoader = async () => {
    stampedeDbQueries++;
    // Simulate 40ms network DB latency
    await new Promise((r) => setTimeout(r, 40));
    return [{ id: 'mock-offer-1', title: 'Flat 20% Off', isActive: true }];
  };

  const stampedeRequests = Array.from({ length: 100 }, () => getOrLoadOffers(db, stampedeMockLoader));
  const stampedeResults = await Promise.all(stampedeRequests);

  console.log(`100 simultaneous requests fired for /api/offers.`);
  console.log(`Actual loader execution count: ${stampedeDbQueries}`);
  if (stampedeDbQueries !== 1) {
    throw new Error(`Stampede prevention failed! Loader executed ${stampedeDbQueries} times instead of 1.`);
  }

  // Verify all 100 received identical response reference
  const firstResult = stampedeResults[0];
  for (let i = 1; i < stampedeResults.length; i++) {
    if (stampedeResults[i] !== firstResult) {
      throw new Error(`Request ${i} got a different result in stampede coalescing`);
    }
  }
  console.log('✓ Test B passed: Exactly 1 database load for 100 concurrent requests; all received identical data.');

  // Test C: 100 Warm Requests (0 MySQL Queries)
  console.log('\n--- Test C: 100 Warm Requests from RAM ---');
  // Reset instrumented query counter
  dbQueries = 0;
  const warmStart = performance.now();
  for (let i = 1; i <= 100; i++) {
    const warmOffers = await getActiveOffers(instrumentedDb);
    if (!Array.isArray(warmOffers)) throw new Error('warmOffers must be an array');
  }
  const warmEnd = performance.now();

  console.log(`100 warm requests completed in ${(warmEnd - warmStart).toFixed(2)} ms (avg ${((warmEnd - warmStart) / 100).toFixed(3)} ms/request).`);
  console.log(`MySQL queries executed during 100 warm requests: ${dbQueries}`);
  if (dbQueries !== 0) {
    throw new Error(`Expected 0 MySQL queries on warm requests, but observed ${dbQueries}!`);
  }
  console.log('✓ Test C passed: 100 customer polls served 100% from RAM with 0 MySQL queries.');

  // Test D: Admin Offer Mutation & Invalidation
  console.log('\n--- Test D: Admin Mutation & Invalidation Flow ---');
  // Ensure cache is populated
  await getActiveOffers(db);
  stats = getOffersCacheStats();
  if (!stats.isCached) throw new Error('Cache should be populated before mutation');

  console.log('Creating test offer via addOffer()...');
  const testOffer = await addOffer(db, {
    title: 'AUDIT_TEMP_TEST_OFFER',
    description: 'Temporary offer to verify cache invalidation',
    code: 'TEST50',
    discountTag: '50% OFF',
    isActive: true,
  });

  stats = getOffersCacheStats();
  console.log('Cache stats immediately after addOffer():', stats);
  if (stats.isCached) {
    throw new Error('addOffer() failed to invalidate offers cache');
  }
  console.log('✓ addOffer() invalidated cache cleanly.');

  // Test E: Next Request After Invalidation (1 MySQL Reload -> Cache Repopulated)
  console.log('\n--- Test E: Next Request Reloads from MySQL ---');
  dbQueries = 0;
  const postMutationOffers = await getActiveOffers(instrumentedDb);
  console.log(`Post-mutation load queries: ${dbQueries}`);
  if (dbQueries !== 1) {
    throw new Error(`Expected exactly 1 MySQL query after invalidation, got ${dbQueries}`);
  }
  const createdFound = postMutationOffers.some((o) => o.id === testOffer.id);
  console.log(`Newly created offer found in fresh response: ${createdFound}`);
  if (!createdFound) throw new Error('New offer was not present in reloaded cache');

  stats = getOffersCacheStats();
  if (!stats.isCached) throw new Error('Cache should be repopulated after reload');
  console.log('✓ Test E passed: Next request reloaded from MySQL once and repopulated cache.');

  // Clean up test offer via deleteOffer
  console.log('Cleaning up test offer via deleteOffer()...');
  await deleteOffer(db, testOffer.id);
  stats = getOffersCacheStats();
  if (stats.isCached) throw new Error('deleteOffer() failed to invalidate cache');
  console.log('✓ deleteOffer() invalidated cache cleanly.');

  // Reload cache after cleanup
  await getActiveOffers(db);

  // Test F: Error Handling / DB Error Resilience
  console.log('\n--- Test F: Error Resilience ---');
  const brokenDb = {
    all: async () => {
      throw new Error('MySQL connection dropped');
    },
    run: async () => {},
  };

  // Even if cache is cleared, a broken query throws cleanly without leaving dangling inFlight
  resetOffersCacheForTesting();
  try {
    await getActiveOffers(brokenDb);
    throw new Error('Should have thrown on broken DB');
  } catch (err) {
    if (err.message !== 'MySQL connection dropped') throw err;
    console.log('✓ Error surfaced cleanly from failing DB load.');
  }

  stats = getOffersCacheStats();
  if (stats.inFlight) throw new Error('inFlight load flag was not cleaned up after error');
  if (stats.isCached) throw new Error('Cache should not store corrupt data on error');
  console.log('✓ Test F passed: In-flight state and cache clean after error; ready for retry.');

  // Test G: Backend Restart Simulation
  console.log('\n--- Test G: Backend Restart Simulation ---');
  console.log('Simulating server restart (Node process memory cleared)...');
  resetOffersCacheForTesting();
  stats = getOffersCacheStats();
  if (stats.isCached) throw new Error('Cache must be empty after restart simulation');

  // First request after restart: queries MySQL once
  dbQueries = 0;
  const restartedOffers = await getActiveOffers(instrumentedDb);
  console.log(`Queries on first request after restart: ${dbQueries}`);
  if (dbQueries !== 1) throw new Error('Expected 1 MySQL query on first restart request');

  // Next 100 requests: 0 queries
  dbQueries = 0;
  for (let i = 1; i <= 100; i++) {
    const o = await getActiveOffers(instrumentedDb);
    if (o.length !== restartedOffers.length) throw new Error('Inconsistent length');
  }
  console.log(`Queries on 100 subsequent requests after restart: ${dbQueries}`);
  if (dbQueries !== 0) throw new Error('Expected 0 queries for subsequent requests');
  console.log('✓ Test G passed: Restart reloads once, then all 100 requests served from RAM.');

  console.log('\n================================================================');
  console.log('🎉 ALL 7 CUSTOMER OFFERS CACHE VERIFICATION CHECKS PASSED!');
  console.log('================================================================\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
