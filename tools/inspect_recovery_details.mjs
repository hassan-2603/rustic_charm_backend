import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
  user: 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: 'defaultdb',
  port: 19138,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const [jobs] = await pool.query(`
    SELECT pj.id as print_job_id, pj.order_id, pj.payload, pj.created_at
    FROM print_jobs pj
    WHERE pj.type = 'BILL' AND pj.created_at >= '2026-09-01 00:00:00' AND pj.created_at < '2026-09-06 05:54:35'
    ORDER BY pj.created_at ASC
  `);

  const [existingOrders] = await pool.query(`SELECT id, order_number FROM orders`);
  const existingOrderIds = new Set(existingOrders.map(o => o.id));

  // Deduplicate by orderNumber + date
  const uniqueOrders = new Map();

  for (const job of jobs) {
    try {
      const data = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      const bill = data?.bill;
      if (!bill || !bill.orderNumber) continue;

      if (job.order_id && existingOrderIds.has(job.order_id)) {
        continue; // Already exists in orders
      }

      // Date key in IST
      const d = new Date(job.created_at).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const datePart = d.split(',')[0]; // e.g. 9/1/2026
      const key = `${datePart}_${bill.orderNumber}`;

      // If already present, keep the one with larger finalTotal or later job
      if (!uniqueOrders.has(key)) {
        uniqueOrders.set(key, { job, bill });
      } else {
        const existing = uniqueOrders.get(key);
        if ((bill.finalTotal || bill.total || 0) >= (existing.bill.finalTotal || existing.bill.total || 0)) {
          uniqueOrders.set(key, { job, bill });
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  console.log('Unique missing orders found:', uniqueOrders.size);

  let totalRev = 0;
  const byDate = {};

  for (const [key, { job, bill }] of uniqueOrders.entries()) {
    const d = new Date(job.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const tot = bill.finalTotal ?? bill.total ?? 0;
    totalRev += tot;
    byDate[d] = byDate[d] || { count: 0, revenue: 0 };
    byDate[d].count++;
    byDate[d].revenue += tot;
  }

  console.log('By date (IST):', byDate);
  console.log('Total revenue to restore:', totalRev);

  const [earlySep6] = await pool.query(`
    SELECT id, type, created_at, payload FROM print_jobs 
    WHERE type = 'BILL' AND created_at >= '2026-09-05 18:30:00' AND created_at < '2026-09-06 05:54:35'
  `);
  console.log('Early Sep 6 BILL jobs:', earlySep6.length);
  for (const b of earlySep6) {
    console.log(b.created_at, b.payload);
  }




  await pool.end();
}

check();
