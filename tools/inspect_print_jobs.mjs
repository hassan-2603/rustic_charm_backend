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
  const [cols] = await pool.query('DESCRIBE print_jobs');
  console.log('Columns in print_jobs:', cols.map(c => c.Field));

  const [dateCounts] = await pool.query(`
    SELECT DATE(created_at) as d, count(*) as count, type
    FROM print_jobs 
    WHERE created_at >= '2026-09-01'
    GROUP BY DATE(created_at), type
    ORDER BY d ASC
  `);
  console.log('Print jobs by date:', dateCounts);

  const [sampleBill] = await pool.query(`
    SELECT id, order_id, type, status, payload, created_at FROM print_jobs 
    WHERE type = 'BILL' AND created_at >= '2026-09-01' AND created_at < '2026-09-06'
    LIMIT 3
  `);
  console.log('Sample BILL jobs:');
  for (const b of sampleBill) {
    console.log('Date:', b.created_at);
    console.log('Payload:', b.payload);
  }



  await pool.end();
}

check();
