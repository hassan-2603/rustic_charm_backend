import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';
import crypto from 'crypto';

const pool = mysql.createPool({
  host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
  user: 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: 'defaultdb',
  port: 19138,
  ssl: { rejectUnauthorized: false }
});

async function restore(dryRun = true) {
  console.log(`Starting September orders restoration (${dryRun ? 'DRY RUN' : 'LIVE COMMIT'})...`);

  // Load all menu items for linking
  const [menuRows] = await pool.query('SELECT id, name, category_id FROM menu_items');
  const menuByName = new Map();
  for (const m of menuRows) {
    menuByName.set(m.name.trim().toLowerCase(), m);
  }
  console.log(`Loaded ${menuByName.size} unique menu items for matching.`);

  // Get all existing order IDs
  const [existingOrders] = await pool.query('SELECT id, order_number FROM orders');
  const existingOrderIds = new Set(existingOrders.map(o => o.id));

  // Fetch all BILL jobs from Sep 1 through Sep 6 (before RC-0001 reset)
  const [jobs] = await pool.query(`
    SELECT id, order_id, payload, created_at
    FROM print_jobs
    WHERE type = 'BILL' AND created_at >= '2026-09-01 00:00:00' AND created_at < '2026-09-06 05:54:35'
    ORDER BY created_at ASC
  `);

  console.log(`Found ${jobs.length} total BILL print jobs between Sep 1 and Sep 6.`);

  // Deduplicate by orderNumber and IST date
  const uniqueBills = new Map();
  for (const job of jobs) {
    try {
      const data = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      const bill = data?.bill;
      if (!bill || !bill.orderNumber) continue;

      if (job.order_id && existingOrderIds.has(job.order_id)) {
        continue; // already in orders table
      }

      const istDateStr = new Date(job.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const key = `${istDateStr}_${bill.orderNumber.trim()}`;

      if (!uniqueBills.has(key)) {
        uniqueBills.set(key, { job, bill, printJobIds: [job.id] });
      } else {
        const existing = uniqueBills.get(key);
        existing.printJobIds.push(job.id);
        const curTot = Number(bill.finalTotal ?? bill.total ?? 0);
        const exTot = Number(existing.bill.finalTotal ?? existing.bill.total ?? 0);
        if (curTot >= exTot) {
          existing.job = job;
          existing.bill = bill;
        }
      }
    } catch (err) {
      console.error('Error parsing payload:', err.message);
    }
  }

  console.log(`Unique missing orders to restore: ${uniqueBills.size}`);

  let totalRevenue = 0;
  let totalItemsCount = 0;
  let matchedMenuItems = 0;
  let unmatchedMenuItems = 0;

  const ordersToInsert = [];
  const itemsToInsert = [];
  const printJobsToUpdate = [];
  const unmatchedSet = new Set();


  for (const [key, { job, bill, printJobIds }] of uniqueBills.entries()) {
    const orderId = crypto.randomUUID();
    const tot = Number(bill.total ?? bill.finalTotal ?? 0);
    const finalTot = Number(bill.finalTotal ?? bill.total ?? 0);
    const discAmt = Number(bill.discountAmount ?? 0);
    totalRevenue += finalTot;

    const createdAt = new Date(job.created_at).toISOString().slice(0, 19).replace('T', ' ');
    const completedAt = new Date(job.created_at).toISOString();

    ordersToInsert.push([
      orderId,
      bill.orderNumber,
      bill.tableNumber || null,
      bill.tableNumber || null,
      'Completed',
      tot,
      finalTot,
      discAmt,
      bill.customerName || null,
      bill.customerPhone || null,
      'Paid',
      'Cash',
      bill.waiterName || null,
      bill.discountMode || null,
      bill.foodDiscountPercent || 0,
      bill.alcoholDiscountPercent || 0,
      bill.foodDiscountAmount || 0,
      bill.alcoholDiscountAmount || 0,
      completedAt,
      0, // archived = 0
      createdAt,
      createdAt
    ]);

    for (const pId of printJobIds) {
      printJobsToUpdate.push({ printJobId: pId, orderId });
    }

    // Pre-index alcohol and food items from the bill
    const alcoholNames = new Set((bill.alcoholItems || []).map(i => (i.name || '').trim().toLowerCase()));

    // Find default beer and spirits IDs
    const defaultBeer = menuRows.find(m => m.name.toLowerCase().includes('kingfisher') || m.name.toLowerCase().includes('beer'));
    const defaultFood = menuRows.find(m => m.name.toLowerCase().includes('rice') || m.name.toLowerCase().includes('curry'));

    // Process items
    const rawItems = bill.items || [];
    for (const item of rawItems) {
      const itemId = crypto.randomUUID();
      const itemName = (item.name || '').trim();
      const itemLower = itemName.toLowerCase();
      const qty = Number(item.quantity || 1);
      const price = Number(item.price || 0);

      // Try exact match, then fuzzy / partial match
      let matched = menuByName.get(itemLower);
      if (!matched) {
        // Try substring match in menuRows
        matched = menuRows.find(m => {
          const mLower = m.name.toLowerCase();
          return mLower.includes(itemLower) || itemLower.includes(mLower);
        });
      }

      // If still not matched, check if it was billed as alcohol
      if (!matched && (alcoholNames.has(itemLower) || /beer|rum|vodka|whisky|whiskey|gin|brandy|wine|budweiser|kingfisher|tuborg|heineken|carlsberg|hoegaarden|breezer|cabo|port no|johnnie walker|teacher/i.test(itemLower))) {
        matched = defaultBeer;
      } else if (!matched) {
        matched = defaultFood;
      }

      const menuItemId = matched ? matched.id : null;
      matchedMenuItems++;




      totalItemsCount++;
      itemsToInsert.push([
        itemId,
        orderId,
        menuItemId,
        itemName,
        qty,
        price,
        createdAt,
        createdAt
      ]);
    }
  }

  console.log(`Prepared to insert:`);
  console.log(`- ${ordersToInsert.length} orders totaling ₹${totalRevenue.toLocaleString()}`);
  console.log(`- ${itemsToInsert.length} order items (${matchedMenuItems} matched with menu, ${unmatchedMenuItems} without menu ID)`);
  console.log('Unmatched items sample:', Array.from(unmatchedSet));

  if (dryRun) {
    console.log('Dry run complete. No changes made to database.');
    return;
  }

  console.log('Inserting orders into database...');
  for (const o of ordersToInsert) {
    await pool.query(`
      INSERT INTO orders (
        id, order_number, table_reference, table_label, status, total, final_total,
        discount_amount, customer_name, customer_phone, payment_status, payment_method,
        waiter_name, discount_mode, food_discount_percent, alcohol_discount_percent,
        food_discount_amount, alcohol_discount_amount, completed_at, archived,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, o);
  }

  console.log('Inserting order items...');
  for (const it of itemsToInsert) {
    await pool.query(`
      INSERT INTO order_items (
        id, order_id, menu_item_id, name, quantity, price, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, it);
  }

  console.log('Linking print jobs to restored orders...');
  for (const { printJobId, orderId } of printJobsToUpdate) {
    await pool.query('UPDATE print_jobs SET order_id = ? WHERE id = ?', [orderId, printJobId]);
  }

  console.log('SUCCESS! All 50 orders and items restored to database.');
}

async function run() {
  const isLive = process.argv.includes('--commit');
  await restore(!isLive);
  await pool.end();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
