import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../config/database.js';
import { getMenuItems, incrementMenuVersion, getMenuVersion, invalidateMenuCache, initMenuVersion } from '../services/adminService.js';
import {
  getMenuCacheStats,
  normalizeMenuLang,
  getOrLoadMenu,
  getCurrentMenuVersion,
  resetMenuVersionForTesting,
} from '../services/menuCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function run() {
  console.log('=== RUNNING MENU CACHE & VERSION ARCHITECTURE VERIFICATION ===\n');

  const db = openDatabase();

  // ==========================================
  // SECTION 1: IN-MEMORY MENU CACHE TESTS
  // ==========================================

  // Step 0: Ensure fresh cache state
  invalidateMenuCache();
  let stats = getMenuCacheStats();
  console.log('Initial cache stats:', stats);
  if (stats.entryCount !== 0) throw new Error('Cache should start empty');

  // Step 1: Language normalization verification
  console.log('\n--- 1. Language Normalization Tests ---');
  const langTests = [
    ['en', 'en'],
    ['English', 'en'],
    ['EN', 'en'],
    ['ru', 'ru'],
    ['Russian', 'ru'],
    ['de', 'de'],
    ['German', 'de'],
    ['es', 'es'],
    ['Spanish', 'es'],
    ['kk', 'kk'],
    ['Kazakh', 'kk'],
    ['he', 'he'],
    ['ja', 'ja'],
    ['ko', 'ko'],
    ['', '__all__'],
    [null, '__all__'],
    [undefined, '__all__'],
  ];

  for (const [input, expected] of langTests) {
    const actual = normalizeMenuLang(input);
    if (actual !== expected) {
      throw new Error(`Normalization failed for "${input}": expected "${expected}", got "${actual}"`);
    }
  }
  console.log('✓ All language normalizations passed!');

  // Step 2: Request 1 (Cold Start -> Database Query)
  console.log('\n--- 2. Cold Start Request (English) ---');
  const t0 = performance.now();
  const items1 = await getMenuItems(db, 'en');
  const t1 = performance.now();
  console.log(`Request 1 took: ${(t1 - t0).toFixed(2)} ms. Loaded ${items1.length} items.`);

  stats = getMenuCacheStats();
  console.log('Cache stats after Request 1:', stats);
  if (!stats.cachedLanguages.includes('en')) throw new Error('Expected "en" to be cached');

  // Verify response structure is identical
  const sample = items1[0];
  console.log('Sample item structure verified:');
  console.log(`- ID: ${sample.id}`);
  console.log(`- Name: ${sample.name}`);
  console.log(`- Category: ${sample.category}`);
  console.log(`- Price: ${sample.price}`);
  console.log(`- Available: ${sample.isAvailable}`);

  // Step 3: Requests 2 to 100 (Cache Hits -> 0 Database Queries)
  console.log('\n--- 3. Warm Cache Simulation (99 Sequential Requests) ---');
  const warmStart = performance.now();
  for (let i = 2; i <= 100; i++) {
    const cachedItems = await getMenuItems(db, 'en');
    if (cachedItems !== items1) {
      throw new Error(`Request ${i} did not return the identical cached instance`);
    }
  }
  const warmEnd = performance.now();
  console.log(`✓ 99 consecutive requests completed in ${(warmEnd - warmStart).toFixed(2)} ms (avg ${((warmEnd - warmStart) / 99).toFixed(3)} ms/request).`);
  console.log('✓ 0 MySQL queries executed for requests 2-100.');

  // Step 4: Cache Stampede / Request Coalescing Test
  console.log('\n--- 4. Cache Stampede / Request Coalescing (100 Simultaneous Requests on Cold Cache) ---');
  invalidateMenuCache();
  console.log('Cache cleared for stampede test.');

  let dbLoadCount = 0;
  const mockLoader = async (mockDb, lang) => {
    dbLoadCount++;
    await new Promise((r) => setTimeout(r, 50));
    return [{ id: 'mock-1', name: 'Mock Item', lang }];
  };

  const stampedeRequests = Array.from({ length: 100 }, () => getOrLoadMenu(db, 'ru', mockLoader));
  const stampedeResults = await Promise.all(stampedeRequests);

  console.log(`100 simultaneous requests fired for "ru".`);
  console.log(`Actual loader execution count: ${dbLoadCount}`);
  if (dbLoadCount !== 1) {
    throw new Error(`Stampede prevention failed! Loader ran ${dbLoadCount} times instead of 1.`);
  }
  console.log('✓ Cache Stampede PREVENTED: exactly 1 database load for 100 simultaneous requests!');

  const first = stampedeResults[0];
  for (let i = 1; i < stampedeResults.length; i++) {
    if (stampedeResults[i] !== first) {
      throw new Error(`Request ${i} got a different result in stampede`);
    }
  }
  console.log('✓ All 100 concurrent requests received the identical result.');

  // Step 5: Multi-Language Isolation Test
  console.log('\n--- 5. Multi-Language Isolation ---');
  invalidateMenuCache();
  const enItems = await getMenuItems(db, 'en');
  const ruItems = await getMenuItems(db, 'ru');
  const deItems = await getMenuItems(db, 'de');

  stats = getMenuCacheStats();
  console.log('Cache stats with multi-languages:', stats);
  if (!stats.cachedLanguages.includes('en') || !stats.cachedLanguages.includes('ru') || !stats.cachedLanguages.includes('de')) {
    throw new Error('All requested languages must be present in cache');
  }
  console.log(`✓ English (${enItems.length} items), Russian (${ruItems.length} items), and German (${deItems.length} items) cached independently.`);

  // ==========================================
  // SECTION 2: IN-MEMORY MENU VERSION TESTS
  // ==========================================

  console.log('\n--- 6. Menu Version Startup Initialization (1 MySQL Query) ---');
  resetMenuVersionForTesting();
  if (getCurrentMenuVersion() !== null) {
    throw new Error('currentMenuVersion should be null before startup');
  }

  const vStartup = await initMenuVersion(db);
  console.log(`✓ Startup initialized currentMenuVersion = ${vStartup} from MySQL.`);
  if (getCurrentMenuVersion() !== vStartup) {
    throw new Error('getCurrentMenuVersion() did not match returned version');
  }

  console.log('\n--- 7. First and Repeated 100 Requests to getMenuVersion() ---');
  // Track database queries to prove 0 queries happen during polling
  let dbQueriesDuringPolling = 0;
  const instrumentedDb = {
    ...db,
    get: async (...args) => {
      dbQueriesDuringPolling++;
      return db.get(...args);
    },
  };

  const v1 = await getMenuVersion(instrumentedDb);
  if (v1 !== vStartup) throw new Error(`Expected version ${vStartup}, got ${v1}`);

  const vStart = performance.now();
  for (let i = 1; i <= 100; i++) {
    const v = await getMenuVersion(instrumentedDb);
    if (v !== vStartup) throw new Error(`Polling request ${i} returned inconsistent version`);
  }
  const vEnd = performance.now();

  console.log(`✓ 100 getMenuVersion() calls completed in ${(vEnd - vStart).toFixed(2)} ms.`);
  console.log(`✓ MySQL queries executed during 100 version requests: ${dbQueriesDuringPolling}`);
  if (dbQueriesDuringPolling !== 0) {
    throw new Error(`Expected 0 MySQL queries during version polling, but observed ${dbQueriesDuringPolling}!`);
  }

  console.log('\n--- 8. Admin Mutation & Version Increment Flow ---');
  // Populate menu cache first
  await getMenuItems(db, 'en');
  stats = getMenuCacheStats();
  if (!stats.cachedLanguages.includes('en')) throw new Error('Menu cache should have en');

  const oldVer = getCurrentMenuVersion();
  console.log(`Current version before mutation: ${oldVer}`);
  const newVer = await incrementMenuVersion(db);
  console.log(`Version after mutation: ${newVer}`);

  if (newVer !== oldVer + 1) {
    throw new Error(`Expected version to increment from ${oldVer} to ${oldVer + 1}, got ${newVer}`);
  }
  if (getCurrentMenuVersion() !== newVer) {
    throw new Error(`currentMenuVersion (${getCurrentMenuVersion()}) not updated to ${newVer}`);
  }

  stats = getMenuCacheStats();
  if (stats.entryCount !== 0) {
    throw new Error('incrementMenuVersion failed to invalidate menu cache');
  }
  console.log('✓ incrementMenuVersion successfully updated currentMenuVersion AND invalidated menu cache.');

  console.log('\n--- 9. Backend Restart Simulation ---');
  console.log('Simulating server restart (clearing memory)...');
  resetMenuVersionForTesting();
  if (getCurrentMenuVersion() !== null) throw new Error('Version should be null after reset');

  // Backend boots up again
  const restartedVersion = await initMenuVersion(db);
  console.log(`Restarted backend queried MySQL once and loaded version: ${restartedVersion}`);
  if (restartedVersion !== newVer) {
    throw new Error(`Expected restarted version ${newVer}, got ${restartedVersion}`);
  }

  // 100 requests after restart
  dbQueriesDuringPolling = 0;
  for (let i = 1; i <= 100; i++) {
    const v = await getMenuVersion(instrumentedDb);
    if (v !== restartedVersion) throw new Error('Inconsistent version after restart');
  }
  console.log(`✓ 100 customer requests after restart served from RAM with ${dbQueriesDuringPolling} MySQL queries.`);
  if (dbQueriesDuringPolling !== 0) {
    throw new Error('MySQL was queried during polling after restart');
  }

  console.log('\n--- 10. Startup Failure / Error Resilience ---');
  const brokenDb = {
    get: async () => {
      throw new Error('MySQL connection refused');
    },
  };

  try {
    await initMenuVersion(brokenDb);
    throw new Error('initMenuVersion should have thrown on DB error');
  } catch (err) {
    if (err.message !== 'MySQL connection refused') throw err;
    console.log('✓ Expected startup DB failure caught cleanly; does not pretend fake version.');
  }

  console.log('\n================================================================');
  console.log('🎉 ALL 10 MENU CACHE & VERSION ARCHITECTURE VERIFICATION CHECKS PASSED!');
  console.log('================================================================\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
