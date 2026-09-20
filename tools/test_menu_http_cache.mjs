import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../config/database.js';
import { getMenuItems, getMenuVersion, incrementMenuVersion } from '../services/adminService.js';
import {
  getMenuEtag,
  matchesIfNoneMatch,
  getCurrentMenuVersion,
  initMenuVersion,
  resetMenuVersionForTesting,
  invalidateMenuCache,
} from '../services/menuCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function run() {
  console.log('=== RUNNING MENU HTTP CACHING VERIFICATION (PHASE 3) ===\n');

  const rawDb = openDatabase();
  let dbQueries = 0;
  const instrumentedDb = {
    ...rawDb,
    all: async (...args) => {
      dbQueries++;
      return rawDb.all(...args);
    },
    get: async (...args) => {
      dbQueries++;
      return rawDb.get(...args);
    },
    run: async (...args) => {
      dbQueries++;
      return rawDb.run(...args);
    },
  };

  // Set up Express instance mirroring server.js
  const app = express();
  app.use(express.json());

  app.get('/api/menu', async (req, res) => {
    try {
      let version = getCurrentMenuVersion();
      if (version === null) {
        version = await getMenuVersion(instrumentedDb);
      }
      const etag = getMenuEtag(req.query.lang, version);

      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('ETag', etag);

      const clientEtag = req.headers['if-none-match'];
      if (matchesIfNoneMatch(clientEtag, etag)) {
        return res.status(304).end();
      }

      const items = await getMenuItems(instrumentedDb, req.query.lang);
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Ephemeral test HTTP server listening on ${baseUrl}`);

  try {
    // Initialize version from DB once as done on server startup
    resetMenuVersionForTesting();
    invalidateMenuCache();
    await initMenuVersion(rawDb);
    const initialVersion = getCurrentMenuVersion();
    console.log(`Initial currentMenuVersion in RAM: ${initialVersion}`);

    // =========================================================================
    // TEST A — First request (Cold / Warm RAM)
    // =========================================================================
    console.log('\n--- TEST A: First Request (No If-None-Match) ---');
    dbQueries = 0;
    const resA = await fetch(`${baseUrl}/api/menu?lang=en`);
    const statusA = resA.status;
    const etagA = resA.headers.get('etag');
    const cacheControlA = resA.headers.get('cache-control');
    const itemsA = await resA.json();

    console.log(`Status: ${statusA} (Expected 200)`);
    console.log(`ETag: ${etagA}`);
    console.log(`Cache-Control: ${cacheControlA}`);
    console.log(`Items count: ${itemsA.length}`);
    console.log(`DB queries on first load: ${dbQueries}`);

    if (statusA !== 200) throw new Error(`TEST A FAILED: Expected status 200, got ${statusA}`);
    if (!etagA || !etagA.startsWith('W/"menu-v')) throw new Error(`TEST A FAILED: Missing or invalid ETag: ${etagA}`);
    if (cacheControlA !== 'no-cache, must-revalidate') throw new Error(`TEST A FAILED: Invalid Cache-Control: ${cacheControlA}`);
    if (!Array.isArray(itemsA) || itemsA.length === 0) throw new Error('TEST A FAILED: Menu items payload empty');
    console.log('✓ TEST A passed: First request returned HTTP 200, JSON payload, and valid ETag.');

    // =========================================================================
    // TEST B — Unchanged conditional request (Matching ETag)
    // =========================================================================
    console.log('\n--- TEST B: Unchanged Conditional Request (If-None-Match Matching) ---');
    dbQueries = 0;
    const resB = await fetch(`${baseUrl}/api/menu?lang=en`, {
      headers: {
        'If-None-Match': etagA,
      },
    });
    const statusB = resB.status;
    const etagB = resB.headers.get('etag');
    const bodyTextB = await resB.text();

    console.log(`Status: ${statusB} (Expected 304)`);
    console.log(`ETag: ${etagB}`);
    console.log(`Body length: ${bodyTextB.length} bytes (Expected 0)`);
    console.log(`DB queries on 304 revalidation: ${dbQueries} (Expected 0)`);

    if (statusB !== 304) throw new Error(`TEST B FAILED: Expected status 304, got ${statusB}`);
    if (bodyTextB.length !== 0) throw new Error(`TEST B FAILED: 304 response should have empty body, got length ${bodyTextB.length}`);
    if (dbQueries !== 0) throw new Error(`TEST B FAILED: 304 response executed ${dbQueries} DB queries, expected 0`);
    console.log('✓ TEST B passed: Conditional request returned HTTP 304, 0 payload bytes, and EXACTLY 0 DB queries.');

    // =========================================================================
    // TEST C — Changed menu (Admin Mutation)
    // =========================================================================
    console.log('\n--- TEST C: Changed Menu (Mutation Updates Version & ETag) ---');
    console.log(`Mutating menu version from ${initialVersion}...`);
    const newVersion = await incrementMenuVersion(rawDb);
    console.log(`New menu version in DB and RAM: ${newVersion}`);

    // Request again using the OLD ETag (etagA)
    dbQueries = 0;
    const resC = await fetch(`${baseUrl}/api/menu?lang=en`, {
      headers: {
        'If-None-Match': etagA, // old ETag
      },
    });
    const statusC = resC.status;
    const etagC = resC.headers.get('etag');
    const itemsC = await resC.json();

    console.log(`Status with old ETag: ${statusC} (Expected 200)`);
    console.log(`New ETag returned: ${etagC}`);
    console.log(`Old ETag was: ${etagA}`);
    console.log(`Items count: ${itemsC.length}`);

    if (statusC !== 200) throw new Error(`TEST C FAILED: Expected status 200 on changed version, got ${statusC}`);
    if (etagC === etagA) throw new Error(`TEST C FAILED: ETag did not change after mutation! Still ${etagC}`);
    if (!etagC.includes(`menu-v${newVersion}`)) throw new Error(`TEST C FAILED: New ETag does not reflect new version: ${etagC}`);
    console.log('✓ TEST C passed: Mutation invalidated old ETag; fresh HTTP 200 with new ETag returned.');

    // =========================================================================
    // TEST D — Language isolation
    // =========================================================================
    console.log('\n--- TEST D: Language Isolation ---');
    // Request English
    const resEn = await fetch(`${baseUrl}/api/menu?lang=en`);
    const etagEn = resEn.headers.get('etag');

    // Request Russian
    const resRu = await fetch(`${baseUrl}/api/menu?lang=ru`);
    const etagRu = resRu.headers.get('etag');

    console.log(`English ETag: ${etagEn}`);
    console.log(`Russian ETag: ${etagRu}`);

    if (etagEn === etagRu) throw new Error('TEST D FAILED: English and Russian ETags must not be identical');
    if (!etagEn.includes('-en') || !etagRu.includes('-ru')) {
      throw new Error('TEST D FAILED: Language tag not properly embedded in ETag');
    }

    // Sending English ETag to Russian endpoint must NOT produce 304
    const crossLangRes = await fetch(`${baseUrl}/api/menu?lang=ru`, {
      headers: { 'If-None-Match': etagEn },
    });
    console.log(`Russian response status with English ETag: ${crossLangRes.status} (Expected 200)`);
    if (crossLangRes.status !== 200) {
      throw new Error(`TEST D FAILED: Cross-language ETag produced status ${crossLangRes.status}, expected 200`);
    }
    console.log('✓ TEST D passed: Language isolation verified (separate ETags and independent revalidation).');

    // =========================================================================
    // TEST E — Categories preservation
    // =========================================================================
    console.log('\n--- TEST E: Categories Preservation ---');
    const sampleItem = itemsA.find((i) => i.category && i.categoryId);
    if (!sampleItem) throw new Error('TEST E FAILED: Menu items missing category / categoryId properties');
    console.log(`Sample item category: ${sampleItem.category} (ID: ${sampleItem.categoryId})`);
    console.log('✓ TEST E passed: Category properties and structure preserved in menu items.');

    // =========================================================================
    // TEST F — Existing frontend compatibility
    // =========================================================================
    console.log('\n--- TEST F: Frontend Schema Compatibility ---');
    // Ensure the shape of item in itemsA has all standard frontend fields
    const requiredFields = ['id', 'name', 'price', 'category', 'isAvailable'];
    for (const f of requiredFields) {
      if (!(f in sampleItem)) throw new Error(`TEST F FAILED: Required field ${f} missing from menu item`);
    }
    console.log('✓ TEST F passed: Response contract exactly matches frontend requirements.');

    // =========================================================================
    // TEST G — Database workload verification
    // =========================================================================
    console.log('\n--- TEST G: Database Workload Verification ---');
    // 1. Warm request with matching ETag
    dbQueries = 0;
    const resWarm304 = await fetch(`${baseUrl}/api/menu?lang=en`, {
      headers: { 'If-None-Match': etagC },
    });
    if (resWarm304.status !== 304 || dbQueries !== 0) {
      throw new Error(`TEST G FAILED: Expected 304 and 0 queries, got ${resWarm304.status} and ${dbQueries} queries`);
    }

    // 2. Warm request without ETag (served from RAM cache)
    dbQueries = 0;
    const resWarm200 = await fetch(`${baseUrl}/api/menu?lang=en`);
    if (resWarm200.status !== 200 || dbQueries !== 0) {
      throw new Error(`TEST G FAILED: Expected 200 and 0 queries from RAM cache, got ${resWarm200.status} and ${dbQueries} queries`);
    }
    console.log(`304 conditional request DB queries: 0`);
    console.log(`200 warm RAM cache DB queries: 0`);
    console.log('✓ TEST G passed: 0 MySQL queries executed for both 304 revalidations and warm RAM hits.');

    console.log('\n==================================================');
    console.log('ALL PHASE 3 HTTP CACHING TESTS PASSED (7/7)!');
    console.log('==================================================\n');
  } finally {
    server.close();
  }

  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ PHASE 3 HTTP CACHING VERIFICATION FAILED:', err);
  process.exit(1);
});
