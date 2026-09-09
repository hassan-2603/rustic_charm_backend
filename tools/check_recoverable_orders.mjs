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
  // Find all BILL print jobs
  const [jobs] = await pool.query(`
    SELECT pj.id as print_job_id, pj.order_id, pj.payload, pj.created_at
    FROM print_jobs pj
    WHERE pj.type = 'BILL' AND pj.created_at >= '2026-09-01 00:00:00'
    ORDER BY pj.created_at ASC
  `);

  console.log('Total BILL jobs from Sep 1 onwards:', jobs.length);

  // Also get existing order numbers and ids
  const [existingOrders] = await pool.query(`SELECT id, order_number, created_at FROM orders`);
  const existingOrderMap = new Set(existingOrders.map(o => o.id));

  console.log('Existing orders in DB count:', existingOrders.length);

  const missingBills = [];
  for (const job of jobs) {
    try {
      const data = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      const bill = data?.bill;
      if (!bill) continue;

      if (!job.order_id || !existingOrderMap.has(job.order_id)) {
        missingBills.push({ job, bill });
      }
    } catch (e) {}
  }

  console.log('Missing bills count:', missingBills.length);
  // Group by date
  const missingByDate = {};
  for (const m of missingBills) {
    const d = new Date(m.job.created_at).toLocaleDateString('en-CA');
    missingByDate[d] = (missingByDate[d] || 0) + 1;
  }
  console.log('Missing bills by date (local):', missingByDate);


  await pool.end();
}

check();
