/**
 * Phase 3A — Real MySQL Concurrency Test Suite
 * =============================================
 * Tests that InnoDB SELECT...FOR UPDATE actually serializes concurrent
 * bill finalization and item mutations using REAL separate MySQL connections.
 *
 * SAFETY:
 *  - Uses a dedicated isolated database: rc_billing_test
 *  - Never touches defaultdb (production)
 *  - Cleans up all test data after every test
 *  - No production code is modified
 *
 * Database: rc_billing_test (InnoDB, Aiven MySQL — same server, isolated schema)
 * Driver:   mysql2/promise (same as production)
 * Engine:   calculateAuthoritativeBill() — production calculation engine
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { calculateAuthoritativeBill } from '../services/billCalculationService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ─── Test database — ISOLATED from production ────────────────────────────────
const TEST_DB = 'rc_billing_test';

const POOL_CONFIG = {
  host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
  user: 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: TEST_DB,
  port: 19138,
  ssl: { rejectUnauthorized: false },
  connectTimeout: 15000,
  connectionLimit: 20,
};

// ─── Report state ─────────────────────────────────────────────────────────────
const report = {
  totalRuns: 0,
  successfulSerializations: 0,
  anomalies: 0,
  staleTotalMismatches: 0,
  tornReads: 0,
  duplicateFinalizations: 0,
  tests: [],
};

// ─── Bill sections config used for all tests ──────────────────────────────────
const BILL_SECTIONS_CONFIG = {
  'Food': 'Food',
  'Liquor': 'Liquor',
  'test-cat-food': 'Food',
  'test-cat-liquor': 'Liquor',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function formatParams(params = []) {
  return params.map(val => {
    if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)) {
      const d = new Date(val);
      if (!isNaN(d)) return d.toISOString().slice(0, 19).replace('T', ' ');
    }
    return val;
  });
}

/** Wraps a dedicated PoolConnection in the same tx-object shape as production */
function makeTx(conn) {
  return {
    get: async (sql, params = []) => {
      const [rows] = await conn.query(sql, formatParams(params));
      return rows[0] || null;
    },
    all: async (sql, params = []) => {
      const [rows] = await conn.query(sql, formatParams(params));
      return rows;
    },
    run: async (sql, params = []) => {
      const [result] = await conn.query(sql, formatParams(params));
      return { lastID: result.insertId, changes: result.affectedRows };
    },
  };
}

/** Full transaction helper matching production db.transaction() exactly */
async function runTransaction(pool, callback) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  const tx = makeTx(conn);
  try {
    const result = await callback(tx, conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Schema bootstrap for test database ───────────────────────────────────────

async function bootstrapSchema(pool) {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      ) ENGINE=InnoDB`);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id VARCHAR(255) PRIMARY KEY,
        category_id VARCHAR(255),
        name VARCHAR(255)
      ) ENGINE=InnoDB`);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(255) PRIMARY KEY,
        order_number VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50) NOT NULL DEFAULT 'Pending',
        total DOUBLE NOT NULL DEFAULT 0,
        final_total DOUBLE,
        frozen_bill_json TEXT,
        discount_mode VARCHAR(50),
        discount_type VARCHAR(50),
        discount_value DOUBLE,
        discount_amount DOUBLE,
        food_discount_percent DOUBLE,
        alcohol_discount_percent DOUBLE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id VARCHAR(255) PRIMARY KEY,
        order_id VARCHAR(255) NOT NULL,
        menu_item_id VARCHAR(255),
        name VARCHAR(255),
        quantity INT NOT NULL DEFAULT 1,
        price DOUBLE NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_oi_order_id (order_id)
      ) ENGINE=InnoDB`);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS restaurant_settings (
        id VARCHAR(255) PRIMARY KEY,
        \`key\` VARCHAR(255) NOT NULL UNIQUE,
        value TEXT
      ) ENGINE=InnoDB`);

    // Seed bill_sections config
    await conn.query(
      "INSERT INTO restaurant_settings (id, `key`, value) VALUES ('bill_sections','bill_sections',?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      [JSON.stringify(BILL_SECTIONS_CONFIG)]
    );
    // Seed categories
    await conn.query(
      "INSERT INTO categories (id, name) VALUES ('test-cat-food','Food'),('test-cat-liquor','Liquor') ON DUPLICATE KEY UPDATE name=VALUES(name)"
    );
    // Seed menu items
    await conn.query(
      `INSERT INTO menu_items (id, category_id, name) VALUES
         ('mi-prawns','test-cat-food','Prawns Masala Fry'),
         ('mi-chicken','test-cat-food','Chicken'),
         ('mi-platter','test-cat-food','Platter'),
         ('mi-pork','test-cat-food','Pork Masala Fry'),
         ('mi-beer','test-cat-liquor','Beer')
       ON DUPLICATE KEY UPDATE category_id=VALUES(category_id), name=VALUES(name)`
    );
    console.log('  OK: Test schema bootstrapped in', TEST_DB);
  } finally {
    conn.release();
  }
}

// ─── Test order factory ────────────────────────────────────────────────────────

async function createTestOrder(pool, { orderId, orderNumber, status = 'Accepted', items,
  discountMode = null, discountValue = null, discountAmount = null,
  foodDiscountPercent = null, alcoholDiscountPercent = null }) {
  const conn = await pool.getConnection();
  try {
    const naiveTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    await conn.query(
      `INSERT INTO orders (id, order_number, status, total, discount_mode, discount_value,
         discount_amount, food_discount_percent, alcohol_discount_percent, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=?, total=?, updated_at=?`,
      [orderId, orderNumber, status, naiveTotal,
       discountMode, discountValue, discountAmount,
       foodDiscountPercent, alcoholDiscountPercent, ts(),
       status, naiveTotal, ts()]
    );
    await conn.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
    for (const item of items) {
      await conn.query(
        `INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, price, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [uuid(), orderId, item.menuItemId || null, item.name, item.quantity, item.price, ts(), ts()]
      );
    }
  } finally {
    conn.release();
  }
}

async function cleanupTestOrder(pool, orderId) {
  const conn = await pool.getConnection();
  try {
    await conn.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
    await conn.query('DELETE FROM orders WHERE id = ?', [orderId]);
  } finally {
    conn.release();
  }
}

async function readFinalState(pool, orderId) {
  const conn = await pool.getConnection();
  try {
    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    const [itemRows] = await conn.query(
      `SELECT oi.*, c.id AS category_id, c.name AS category_name
       FROM order_items oi
       LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
       LEFT JOIN categories c ON mi.category_id = c.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at ASC`,
      [orderId]
    );
    return { order: orderRows[0], items: itemRows };
  } finally {
    conn.release();
  }
}

// ─── Production requestBill logic (mirrors customerService.js exactly) ─────────

async function requestBillReal(pool, orderId) {
  let frozenBill, authTotal, authFinalTotal, connId;

  await runTransaction(pool, async (tx, conn) => {
    const [idRows] = await conn.query('SELECT CONNECTION_ID() AS cid');
    connId = idRows[0].cid;

    let order;
    try {
      order = await tx.get('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    } catch {
      order = await tx.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    }

    if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

    const nonBillable = ['Bill Requested', 'Payment Done', 'Completed', 'Rejected'];
    if (nonBillable.includes(order.status)) {
      const e = new Error(`Cannot request bill for an order with status: ${order.status}`);
      e.status = 400; e.alreadyFinalized = true; throw e;
    }

    const rawItems = await tx.all(
      `SELECT oi.id, oi.menu_item_id, oi.name, oi.quantity, oi.price,
              c.name AS category_name, c.id AS category_id
       FROM order_items oi
       LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
       LEFT JOIN categories c ON mi.category_id = c.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at ASC`,
      [orderId]
    );
    if (!rawItems || rawItems.length === 0) {
      const e = new Error('Cannot finalize a bill for an order with no items');
      e.status = 400; throw e;
    }

    const items = rawItems.map(row => ({
      id: row.id, menuItemId: row.menu_item_id || '',
      name: row.name || '', quantity: Number(row.quantity || 0),
      price: Number(row.price || 0),
      category: row.category_name || '', categoryId: row.category_id || '',
    }));

    const configRow = await tx.get("SELECT value FROM restaurant_settings WHERE `key` = 'bill_sections' LIMIT 1");
    const billSectionsConfig = configRow?.value ? JSON.parse(configRow.value) : {};

    const normalizedOrder = {
      id: order.id, orderNumber: order.order_number,
      discountMode: order.discount_mode, discountType: order.discount_type,
      discountValue: order.discount_value !== null ? Number(order.discount_value) : null,
      discountAmount: order.discount_amount !== null ? Number(order.discount_amount) : null,
      foodDiscountPercent: order.food_discount_percent !== null ? Number(order.food_discount_percent) : null,
      alcoholDiscountPercent: order.alcohol_discount_percent !== null ? Number(order.alcohol_discount_percent) : null,
    };

    frozenBill = calculateAuthoritativeBill(normalizedOrder, items, billSectionsConfig);
    authTotal = frozenBill.total;
    authFinalTotal = frozenBill.finalTotal;

    await tx.run(
      'UPDATE orders SET status=?, total=?, final_total=?, frozen_bill_json=?, updated_at=? WHERE id=?',
      ['Bill Requested', authTotal, authFinalTotal, JSON.stringify(frozenBill), ts(), orderId]
    );
  });

  return { connId, frozenBill, authTotal, authFinalTotal };
}

// ─── Production addOrderItems guard logic ─────────────────────────────────────

async function addOrderItemReal(pool, orderId, item) {
  let connId;
  await runTransaction(pool, async (tx, conn) => {
    const [idRows] = await conn.query('SELECT CONNECTION_ID() AS cid');
    connId = idRows[0].cid;

    let currentOrder;
    try {
      currentOrder = await tx.get('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    } catch {
      currentOrder = await tx.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    }
    if (!currentOrder) throw new Error('Order not found');

    if (currentOrder.status === 'Bill Requested') {
      const e = new Error("Order has been finalized ('Bill Requested'). Items cannot be added.");
      e.status = 409; e.rejected = true; throw e;
    }

    await tx.run(
      'INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, price, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [uuid(), orderId, item.menuItemId || null, item.name, item.quantity, item.price, ts(), ts()]
    );

    const allItems = await tx.all('SELECT quantity, price FROM order_items WHERE order_id = ?', [orderId]);
    const newTotal = allItems.reduce((s, r) => s + Number(r.price) * Number(r.quantity), 0);
    await tx.run('UPDATE orders SET total=?, updated_at=? WHERE id=?', [newTotal, ts(), orderId]);
  });
  return { connId };
}

// ─── Production removeOrderItems guard logic ───────────────────────────────────

async function removeOrderItemReal(pool, orderId, itemName) {
  let connId;
  await runTransaction(pool, async (tx, conn) => {
    const [idRows] = await conn.query('SELECT CONNECTION_ID() AS cid');
    connId = idRows[0].cid;

    let currentOrder;
    try {
      currentOrder = await tx.get('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    } catch {
      currentOrder = await tx.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    }
    if (!currentOrder) throw new Error('Order not found');

    if (currentOrder.status === 'Bill Requested') {
      const e = new Error("Order has been finalized ('Bill Requested'). Items cannot be removed.");
      e.status = 409; e.rejected = true; throw e;
    }

    const target = await tx.get(
      'SELECT id FROM order_items WHERE order_id = ? AND name = ? LIMIT 1', [orderId, itemName]
    );
    if (target) {
      await tx.run('DELETE FROM order_items WHERE id = ?', [target.id]);
    }

    const remaining = await tx.all('SELECT quantity, price FROM order_items WHERE order_id = ?', [orderId]);
    if (remaining.length === 0) throw new Error('Cannot remove every item');

    const newTotal = remaining.reduce((s, r) => s + Number(r.price) * Number(r.quantity), 0);
    await tx.run('UPDATE orders SET total=?, updated_at=? WHERE id=?', [newTotal, ts(), orderId]);
  });
  return { connId };
}

// ─── Production updateOrder discount guard ────────────────────────────────────

async function applyDiscountReal(pool, orderId, discountMode, discountValue) {
  let connId;
  await runTransaction(pool, async (tx, conn) => {
    const [idRows] = await conn.query('SELECT CONNECTION_ID() AS cid');
    connId = idRows[0].cid;

    let currentOrder;
    try {
      currentOrder = await tx.get('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    } catch {
      currentOrder = await tx.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    }
    if (!currentOrder) throw new Error('Order not found');

    if (currentOrder.status === 'Bill Requested') {
      const e = new Error('Order finalized. Discount cannot be applied.');
      e.status = 409; e.rejected = true; throw e;
    }

    await tx.run(
      'UPDATE orders SET discount_mode=?, discount_value=?, updated_at=? WHERE id=?',
      [discountMode, discountValue, ts(), orderId]
    );
  });
  return { connId };
}

// ─── Verification helpers ──────────────────────────────────────────────────────

function verifyFrozenBill(frozenBill) {
  const errs = [];
  if (!frozenBill) return ['frozenBill is null'];
  const itemSum = frozenBill.items.reduce((s, i) => s + Number(i.amount), 0);
  const sectionSum = Number(frozenBill.foodTotal) + Number(frozenBill.alcoholTotal);
  const total = Number(frozenBill.total);
  const finalTotal = Number(frozenBill.finalTotal);
  const discountAmt = Number(frozenBill.discountAmount || 0);
  if (Math.abs(itemSum - total) > 0.01) errs.push(`sum(items.amount)=${itemSum} != total=${total}`);
  if (Math.abs(sectionSum - total) > 0.01) errs.push(`foodTotal+alcoholTotal=${sectionSum} != total=${total}`);
  if (Math.abs(total - discountAmt - finalTotal) > 0.01) errs.push(`total-discount != finalTotal`);
  if (!Array.isArray(frozenBill.items) || frozenBill.items.length === 0) errs.push('items empty');
  for (const item of frozenBill.items) {
    if (!item.section) errs.push(`item "${item.name}" missing section`);
    if (typeof item.quantity !== 'number' || item.quantity < 1) errs.push(`item "${item.name}" bad qty`);
  }
  return errs;
}

function verifyNoTornRead(frozenBill, finalItems) {
  const frozenNames = new Set(frozenBill.items.map(i => i.name));
  const liveNames = new Set(finalItems.map(i => i.name));
  return {
    inFrozenNotLive: [...frozenNames].filter(n => !liveNames.has(n)),
    inLiveNotFrozen: [...liveNames].filter(n => !frozenNames.has(n)),
  };
}

// ─── ASSERTION HELPER ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(condition, message) {
  if (!condition) { console.error(`    FAIL: ${message}`); failed++; }
  else { console.log(`    OK:   ${message}`); passed++; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

const BASE_ITEMS_2200 = [
  { name: 'Prawns Masala Fry', price: 400,  quantity: 1, menuItemId: 'mi-prawns' },
  { name: 'Platter',           price: 450,  quantity: 1, menuItemId: 'mi-platter' },
  { name: 'Pork Masala Fry',   price: 1350, quantity: 1, menuItemId: 'mi-pork' },
];

async function test1_TwoSimultaneousFinalizations(pool) {
  console.log('\n== TEST 1: Two Simultaneous Finalizations (5 runs) ==');
  const testEntry = { test: 'TEST 1', runs: 0, successfulSerializations: 0, anomalies: 0, details: [] };

  for (let run = 1; run <= 5; run++) {
    const orderId = `t1-${Date.now()}-${run}`;
    await createTestOrder(pool, { orderId, orderNumber: `T1-${Date.now()}-${run}`, status: 'Accepted', items: BASE_ITEMS_2200 });
    report.totalRuns++; testEntry.runs++;

    let rA, rB, eA, eB;
    [[rA, eA], [rB, eB]] = await Promise.all([
      requestBillReal(pool, orderId).then(r => [r, null]).catch(e => [null, e]),
      new Promise(res => setTimeout(res, 5)).then(() =>
        requestBillReal(pool, orderId).then(r => [r, null]).catch(e => [null, e])
      ),
    ]);

    const { order: fin, items: finItems } = await readFinalState(pool, orderId);
    const successCount = [eA, eB].filter(e => e === null).length;
    console.log(`\n  Run ${run}: successes=${successCount}, status=${fin?.status}, final_total=${fin?.final_total}`);

    const detail = { run, successCount, finalStatus: fin?.status, finalTotal: fin?.final_total };

    assert(fin?.status === 'Bill Requested', `status='Bill Requested'`);
    assert(successCount === 1, `Exactly 1 finalization succeeded (got ${successCount})`);

    if (rA?.connId && rB?.connId) {
      assert(rA.connId !== rB.connId, `Distinct connections (A=${rA.connId}, B=${rB.connId})`);
    }

    const winner = rA ?? rB;
    if (winner) {
      const fbErrs = verifyFrozenBill(winner.frozenBill);
      assert(fbErrs.length === 0, `Frozen bill consistent (${fbErrs.join('; ')||'OK'})`);
      assert(Math.abs(winner.authTotal - 2200) < 0.01, `Authoritative total = Rs 2200 (got ${winner.authTotal})`);
      assert(Math.abs(Number(fin.final_total) - 2200) < 0.01, `DB final_total = Rs 2200 (got ${fin.final_total})`);
      const torn = verifyNoTornRead(winner.frozenBill, finItems);
      const noTorn = torn.inFrozenNotLive.length === 0 && torn.inLiveNotFrozen.length === 0;
      assert(noTorn, `No torn read`);
      if (!noTorn) { report.tornReads++; testEntry.anomalies++; }
      if (fbErrs.length > 0) { report.staleTotalMismatches++; testEntry.anomalies++; }
    }

    if (successCount !== 1) { report.duplicateFinalizations++; testEntry.anomalies++; detail.anomaly = `${successCount} succeeded`; }
    else testEntry.successfulSerializations++;

    testEntry.details.push(detail);
    await cleanupTestOrder(pool, orderId);
  }
  report.tests.push(testEntry);
  report.successfulSerializations += testEntry.successfulSerializations;
  report.anomalies += testEntry.anomalies;
}

async function test2_AddItemVsFinalize(pool) {
  console.log('\n== TEST 2: Add Item vs Finalize (5 runs) ==');
  const testEntry = { test: 'TEST 2', runs: 0, successfulSerializations: 0, anomalies: 0, details: [] };
  const ADD_ITEM = { name: 'Chicken', price: 400, quantity: 1, menuItemId: 'mi-chicken' };

  for (let run = 1; run <= 5; run++) {
    const orderId = `t2-${Date.now()}-${run}`;
    await createTestOrder(pool, { orderId, orderNumber: `T2-${Date.now()}-${run}`, status: 'Accepted', items: BASE_ITEMS_2200 });
    report.totalRuns++; testEntry.runs++;

    let rAdd, rFin, eAdd, eFin;
    [[rAdd, eAdd], [rFin, eFin]] = await Promise.all([
      addOrderItemReal(pool, orderId, ADD_ITEM).then(r => [r, null]).catch(e => [null, e]),
      new Promise(res => setTimeout(res, 3)).then(() =>
        requestBillReal(pool, orderId).then(r => [r, null]).catch(e => [null, e])
      ),
    ]);

    const { order: fin, items: finItems } = await readFinalState(pool, orderId);
    const trueItemTotal = finItems.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
    console.log(`\n  Run ${run}: add=${eAdd?'REJECTED':'OK'} fin=${eFin?'REJECTED':'OK'} itemTotal=Rs${trueItemTotal} finalTotal=Rs${fin?.final_total}`);

    const detail = { run, trueItemTotal, dbFinalTotal: fin?.final_total };
    const addFirst = !eAdd && !eFin;
    const finFirst = !eFin && eAdd?.rejected;

    if (addFirst) {
      detail.outcome = 'ADD_FIRST';
      assert(Math.abs(trueItemTotal - 2600) < 0.01, `ADD_FIRST: item total = Rs 2600 (got ${trueItemTotal})`);
      assert(Math.abs(Number(fin.final_total) - 2600) < 0.01, `ADD_FIRST: DB final_total = Rs 2600 (got ${fin.final_total})`);
    } else if (finFirst) {
      detail.outcome = 'FIN_FIRST';
      assert(eAdd?.status === 409, `FIN_FIRST: add rejected with 409`);
      assert(Math.abs(trueItemTotal - 2200) < 0.01, `FIN_FIRST: item total = Rs 2200 (got ${trueItemTotal})`);
      assert(Math.abs(Number(fin.final_total) - 2200) < 0.01, `FIN_FIRST: DB final_total = Rs 2200 (got ${fin.final_total})`);
    } else {
      detail.anomaly = `Unexpected: eAdd=${eAdd?.message} eFin=${eFin?.message}`;
    }

    // Stale-mismatch check: DB final_total must equal actual items
    if (fin?.status === 'Bill Requested') {
      const dbFT = Number(fin.final_total);
      if (Math.abs(dbFT - trueItemTotal) > 0.01) {
        report.staleTotalMismatches++;
        testEntry.anomalies++;
        assert(false, `STALE MISMATCH: final_total=${dbFT} != item total=${trueItemTotal}`);
      } else {
        assert(true, `No stale-total mismatch (both = Rs${dbFT})`);
      }
    }

    if (addFirst || finFirst) testEntry.successfulSerializations++;
    else testEntry.anomalies++;

    if (!eFin && rFin?.frozenBill) {
      const fbErrs = verifyFrozenBill(rFin.frozenBill);
      assert(fbErrs.length === 0, `Frozen bill consistent`);
      const torn = verifyNoTornRead(rFin.frozenBill, finItems);
      const noTorn = torn.inFrozenNotLive.length === 0 && torn.inLiveNotFrozen.length === 0;
      assert(noTorn, `No torn read`);
      if (!noTorn) { report.tornReads++; testEntry.anomalies++; }
    }

    testEntry.details.push(detail);
    await cleanupTestOrder(pool, orderId);
  }
  report.tests.push(testEntry);
  report.successfulSerializations += testEntry.successfulSerializations;
  report.anomalies += testEntry.anomalies;
}

async function test3_RemoveItemVsFinalize(pool) {
  console.log('\n== TEST 3: Remove Item vs Finalize (5 runs) ==');
  const testEntry = { test: 'TEST 3', runs: 0, successfulSerializations: 0, anomalies: 0, details: [] };

  for (let run = 1; run <= 5; run++) {
    const orderId = `t3-${Date.now()}-${run}`;
    await createTestOrder(pool, { orderId, orderNumber: `T3-${Date.now()}-${run}`, status: 'Accepted', items: BASE_ITEMS_2200 });
    report.totalRuns++; testEntry.runs++;

    let rRem, rFin, eRem, eFin;
    [[rRem, eRem], [rFin, eFin]] = await Promise.all([
      removeOrderItemReal(pool, orderId, 'Prawns Masala Fry').then(r => [r, null]).catch(e => [null, e]),
      new Promise(res => setTimeout(res, 3)).then(() =>
        requestBillReal(pool, orderId).then(r => [r, null]).catch(e => [null, e])
      ),
    ]);

    const { order: fin, items: finItems } = await readFinalState(pool, orderId);
    const trueItemTotal = finItems.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
    console.log(`\n  Run ${run}: rem=${eRem?'REJECTED':'OK'} fin=${eFin?'REJECTED':'OK'} itemTotal=Rs${trueItemTotal} finalTotal=Rs${fin?.final_total}`);

    const detail = { run, trueItemTotal, dbFinalTotal: fin?.final_total };
    const remFirst = !eRem && !eFin;
    const finFirst = !eFin && eRem?.rejected;

    if (remFirst) {
      detail.outcome = 'REMOVE_FIRST';
      assert(Math.abs(trueItemTotal - 1800) < 0.01, `REMOVE_FIRST: item total = Rs 1800 (got ${trueItemTotal})`);
      assert(Math.abs(Number(fin.final_total) - 1800) < 0.01, `REMOVE_FIRST: DB final_total = Rs 1800 (got ${fin.final_total})`);
    } else if (finFirst) {
      detail.outcome = 'FIN_FIRST';
      assert(eRem?.status === 409, `FIN_FIRST: remove rejected with 409`);
      assert(Math.abs(trueItemTotal - 2200) < 0.01, `FIN_FIRST: item total = Rs 2200 (got ${trueItemTotal})`);
      assert(Math.abs(Number(fin.final_total) - 2200) < 0.01, `FIN_FIRST: DB final_total = Rs 2200 (got ${fin.final_total})`);
    } else {
      detail.anomaly = `Unexpected: eRem=${eRem?.message} eFin=${eFin?.message}`;
    }

    if (fin?.status === 'Bill Requested') {
      const dbFT = Number(fin.final_total);
      if (Math.abs(dbFT - trueItemTotal) > 0.01) {
        report.staleTotalMismatches++; testEntry.anomalies++;
        assert(false, `STALE MISMATCH: final_total=${dbFT} != item total=${trueItemTotal}`);
      } else {
        assert(true, `No stale-total mismatch`);
      }
    }

    if (remFirst || finFirst) testEntry.successfulSerializations++;
    else testEntry.anomalies++;

    testEntry.details.push(detail);
    await cleanupTestOrder(pool, orderId);
  }
  report.tests.push(testEntry);
  report.successfulSerializations += testEntry.successfulSerializations;
  report.anomalies += testEntry.anomalies;
}

async function test4_DiscountVsFinalize(pool) {
  console.log('\n== TEST 4: Discount vs Finalize (5 runs) ==');
  const testEntry = { test: 'TEST 4', runs: 0, successfulSerializations: 0, anomalies: 0, details: [] };

  for (let run = 1; run <= 5; run++) {
    const orderId = `t4-${Date.now()}-${run}`;
    await createTestOrder(pool, { orderId, orderNumber: `T4-${Date.now()}-${run}`, status: 'Accepted', items: BASE_ITEMS_2200 });
    report.totalRuns++; testEntry.runs++;

    let rDisc, rFin, eDisc, eFin;
    [[rDisc, eDisc], [rFin, eFin]] = await Promise.all([
      applyDiscountReal(pool, orderId, 'percent', 10).then(r => [r, null]).catch(e => [null, e]),
      new Promise(res => setTimeout(res, 3)).then(() =>
        requestBillReal(pool, orderId).then(r => [r, null]).catch(e => [null, e])
      ),
    ]);

    const { order: fin } = await readFinalState(pool, orderId);
    console.log(`\n  Run ${run}: disc=${eDisc?'REJECTED':'OK'} fin=${eFin?'REJECTED':'OK'} final_total=Rs${fin?.final_total} discount_mode=${fin?.discount_mode}`);

    const detail = { run, dbFinalTotal: fin?.final_total, discountMode: fin?.discount_mode };
    const discFirst = !eDisc && !eFin;
    const finFirst = !eFin && eDisc?.rejected;

    if (discFirst) {
      detail.outcome = 'DISCOUNT_FIRST';
      // 10% off Rs 2200 = Rs 1980
      assert(Math.abs(Number(fin.final_total) - 1980) < 0.01,
        `DISCOUNT_FIRST: final_total = Rs 1980 (got ${fin.final_total})`);
      assert(fin.discount_mode === 'percent', `discount_mode='percent' persisted`);
    } else if (finFirst) {
      detail.outcome = 'FIN_FIRST';
      assert(eDisc?.status === 409, `FIN_FIRST: discount rejected with 409`);
      assert(Math.abs(Number(fin.final_total) - 2200) < 0.01,
        `FIN_FIRST: final_total = Rs 2200 (got ${fin.final_total})`);
    } else {
      detail.anomaly = `Unexpected: eDisc=${eDisc?.message} eFin=${eFin?.message}`;
    }

    if (discFirst || finFirst) testEntry.successfulSerializations++;
    else testEntry.anomalies++;

    testEntry.details.push(detail);
    await cleanupTestOrder(pool, orderId);
  }
  report.tests.push(testEntry);
  report.successfulSerializations += testEntry.successfulSerializations;
  report.anomalies += testEntry.anomalies;
}

async function test6_RepeatedFinalization(pool) {
  console.log('\n== TEST 6: 10 Simultaneous Finalization Attempts (3 rounds) ==');
  const testEntry = { test: 'TEST 6', runs: 0, successfulSerializations: 0, anomalies: 0, details: [] };

  for (let round = 1; round <= 3; round++) {
    const orderId = `t6-${Date.now()}-${round}`;
    await createTestOrder(pool, { orderId, orderNumber: `T6-${Date.now()}-${round}`, status: 'Accepted', items: BASE_ITEMS_2200 });
    report.totalRuns++; testEntry.runs++;

    const attempts = Array.from({ length: 10 }, (_, i) =>
      new Promise(res => setTimeout(res, i * 2)).then(() =>
        requestBillReal(pool, orderId)
          .then(r => ({ ok: true, result: r, i: i+1 }))
          .catch(e => ({ ok: false, err: e, i: i+1 }))
      )
    );
    const results = await Promise.all(attempts);
    const successes = results.filter(r => r.ok);
    const failures = results.filter(r => !r.ok);

    const { order: fin } = await readFinalState(pool, orderId);
    console.log(`\n  Round ${round}: ${successes.length}/10 succeeded, status=${fin?.status}, final_total=Rs${fin?.final_total}`);
    console.log(`  Successful conn IDs: ${successes.map(r => r.result?.connId).join(', ')}`);

    const detail = { round, successCount: successes.length, failureCount: failures.length, finalStatus: fin?.status, finalTotal: fin?.final_total };

    assert(successes.length === 1, `Exactly 1 of 10 succeeded (got ${successes.length})`);
    assert(fin?.status === 'Bill Requested', `Final status = 'Bill Requested'`);
    assert(Math.abs(Number(fin?.final_total) - 2200) < 0.01, `Final total = Rs 2200 (got ${fin?.final_total})`);

    const finalTotals = new Set(successes.map(r => r.result?.authFinalTotal));
    assert(finalTotals.size <= 1, `All successes agree on total (${[...finalTotals].join(',')})`);

    if (successes.length !== 1) { report.duplicateFinalizations++; testEntry.anomalies++; detail.anomaly = `${successes.length} succeeded`; }
    else testEntry.successfulSerializations++;

    testEntry.details.push(detail);
    await cleanupTestOrder(pool, orderId);
  }
  report.tests.push(testEntry);
  report.successfulSerializations += testEntry.successfulSerializations;
  report.anomalies += testEntry.anomalies;
}

async function test7_RC0594Regression(pool) {
  console.log('\n== TEST 7: RC-0594 Regression (3 runs) ==');
  const testEntry = { test: 'TEST 7', runs: 0, successfulSerializations: 0, anomalies: 0, details: [] };

  const RC0594_ITEMS = [
    { name: 'Beer',              price: 320,  quantity: 1, menuItemId: 'mi-beer' },
    { name: 'Chicken',           price: 400,  quantity: 1, menuItemId: 'mi-chicken' },
    { name: 'Platter',           price: 1350, quantity: 1, menuItemId: 'mi-platter' },
    { name: 'Prawns Masala Fry', price: 400,  quantity: 1, menuItemId: 'mi-prawns' },
  ]; // true total = 2470

  for (let run = 1; run <= 3; run++) {
    const orderId = `t7-${Date.now()}-${run}`;
    await createTestOrder(pool, { orderId, orderNumber: `T7-${Date.now()}-${run}`, status: 'Accepted', items: RC0594_ITEMS });

    // Inject stale total = 1800 (RC-0594 scenario)
    const staleConn = await pool.getConnection();
    await staleConn.query('UPDATE orders SET total = 1800 WHERE id = ?', [orderId]);
    staleConn.release();

    report.totalRuns++; testEntry.runs++;

    let rRem, rFin, eRem, eFin;
    [[rRem, eRem], [rFin, eFin]] = await Promise.all([
      removeOrderItemReal(pool, orderId, 'Prawns Masala Fry').then(r => [r, null]).catch(e => [null, e]),
      new Promise(res => setTimeout(res, 5)).then(() =>
        requestBillReal(pool, orderId).then(r => [r, null]).catch(e => [null, e])
      ),
    ]);

    const { order: fin, items: finItems } = await readFinalState(pool, orderId);
    const trueItemTotal = finItems.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
    const dbFT = Number(fin?.final_total);

    console.log(`\n  Run ${run}: rem=${eRem?'REJECTED':'OK'} fin=${eFin?'REJECTED':'OK'}`);
    console.log(`  Stale DB total=1800, true item total=Rs${trueItemTotal}, DB final_total=Rs${dbFT}`);

    const detail = { run, trueItemTotal, dbFinalTotal: dbFT };

    if (fin?.status === 'Bill Requested') {
      // CRITICAL: frozen total must NOT be the stale 1800
      assert(Math.abs(dbFT - 1800) > 0.01,
        `RC-0594: frozen total is NOT stale 1800 (got Rs${dbFT})`);
      // Must match the actual committed item state
      assert(Math.abs(dbFT - trueItemTotal) < 0.01,
        `RC-0594: DB final_total (Rs${dbFT}) = actual item total (Rs${trueItemTotal})`);

      if (Math.abs(dbFT - 1800) < 0.01) {
        report.staleTotalMismatches++; testEntry.anomalies++; detail.staleMatch = true;
      } else {
        testEntry.successfulSerializations++;
      }
    }

    testEntry.details.push(detail);
    await cleanupTestOrder(pool, orderId);
  }
  report.tests.push(testEntry);
  report.successfulSerializations += testEntry.successfulSerializations;
  report.anomalies += testEntry.anomalies;
}

async function verifyNoTestDataRemains(pool) {
  const conn = await pool.getConnection();
  try {
    const [[o]] = await conn.query("SELECT COUNT(*) AS cnt FROM orders WHERE id LIKE 't%'");
    const [[i]] = await conn.query("SELECT COUNT(*) AS cnt FROM order_items WHERE order_id LIKE 't%'");
    return { orders: o.cnt, items: i.cnt };
  } finally {
    conn.release();
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('================================================================');
  console.log('  Phase 3A - Real MySQL Concurrency Test Suite');
  console.log('  Isolated database:', TEST_DB, '(NOT production defaultdb)');
  console.log('================================================================');

  const pool = mysql.createPool(POOL_CONFIG);

  try {
    console.log('\n[STEP 1] Bootstrapping isolated test schema...');
    await bootstrapSchema(pool);

    // Confirm distinct connections
    const cA = await pool.getConnection();
    const cB = await pool.getConnection();
    const [[{cidA}]] = await cA.query('SELECT CONNECTION_ID() AS cidA');
    const [[{cidB}]] = await cB.query('SELECT CONNECTION_ID() AS cidB');
    console.log(`\n[STEP 2] Connection isolation check: connA=${cidA}, connB=${cidB}`);
    assert(cidA !== cidB, `Pool issues distinct connections (A=${cidA} != B=${cidB})`);
    cA.release(); cB.release();

    await test1_TwoSimultaneousFinalizations(pool);
    await test2_AddItemVsFinalize(pool);
    await test3_RemoveItemVsFinalize(pool);
    await test4_DiscountVsFinalize(pool);
    await test6_RepeatedFinalization(pool);
    await test7_RC0594Regression(pool);

    console.log('\n[STEP 10] Cleanup verification...');
    const remaining = await verifyNoTestDataRemains(pool);
    console.log(`  Remaining test orders: ${remaining.orders}`);
    console.log(`  Remaining test items: ${remaining.items}`);
    assert(remaining.orders === 0, `No test order rows remain in ${TEST_DB}`);
    assert(remaining.items === 0, `No test order_item rows remain in ${TEST_DB}`);

  } finally {
    await pool.end();
  }

  console.log('\n================================================================');
  console.log('  PHASE 3A - CONCURRENCY TEST REPORT');
  console.log('================================================================');
  console.log(`  Total concurrent runs:          ${report.totalRuns}`);
  console.log(`  Successful serializations:      ${report.successfulSerializations}`);
  console.log(`  Anomalies:                      ${report.anomalies}`);
  console.log(`  Stale-total mismatches:         ${report.staleTotalMismatches}`);
  console.log(`  Torn reads:                     ${report.tornReads}`);
  console.log(`  Duplicate finalizations:        ${report.duplicateFinalizations}`);
  console.log(`  Assertions passed:              ${passed}`);
  console.log(`  Assertions failed:              ${failed}`);

  for (const t of report.tests) {
    console.log(`\n  [${t.test}] runs=${t.runs} ok=${t.successfulSerializations} anomalies=${t.anomalies}`);
    for (const d of t.details.filter(d => d.anomaly)) {
      console.log(`    ANOMALY run ${d.run}: ${d.anomaly}`);
    }
  }

  const allGood =
    report.anomalies === 0 &&
    report.staleTotalMismatches === 0 &&
    report.tornReads === 0 &&
    report.duplicateFinalizations === 0 &&
    failed === 0;

  console.log('\n================================================================');
  if (allGood) {
    console.log('  PHASE 3A VERIFIED - REAL MYSQL CONCURRENCY PASSED');
  } else {
    console.log('  PHASE 3A FAILED - CONCURRENCY INVARIANT VIOLATION');
    console.log(`  Anomalies=${report.anomalies} StaleMismatches=${report.staleTotalMismatches} TornReads=${report.tornReads} DuplicateFins=${report.duplicateFinalizations} FailedAsserts=${failed}`);
  }
  console.log('================================================================\n');

  process.exit(allGood ? 0 : 1);
}

main().catch(e => {
  console.error('\n[FATAL]', e);
  process.exit(1);
});
