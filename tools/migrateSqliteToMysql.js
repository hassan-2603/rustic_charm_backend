import sqlite3 from 'sqlite3';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlitePath = path.join(__dirname, '../database/rustic-charm.sqlite');
const offersPath = path.join(__dirname, '../offers.db');

async function migrateData() {
    console.log("Connecting to SQLite (rustic-charm.sqlite)...");
    const sqliteDb = new sqlite3.Database(sqlitePath);

    const getSqliteData = (db, query) => new Promise((resolve, reject) => {
        db.all(query, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

    console.log("Connecting to MySQL...");
    const pool = mysql.createPool({
        host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
        user: 'avnadmin',
        password: process.env.DB_PASSWORD,
        database: 'defaultdb',
        port: 19138,
        ssl: { rejectUnauthorized: false }
    });

    const tables = [
        'restaurant_settings',
        'categories',
        'menu_items',
        'menu_translations',
        'tables',
        'sessions',
        'orders',
        'order_items',
        'waiters',
        'waiter_calls',
        'kitchen_credentials',
        'printers',
        'print_jobs',
        'order_bill_splits'
    ];

    for (const table of tables) {
        try {
            console.log(`Migrating table: ${table}...`);
            const rows = await getSqliteData(sqliteDb, `SELECT * FROM ${table}`);
            if (rows.length === 0) {
                console.log(`  No data in ${table}`);
                continue;
            }

            const columns = Object.keys(rows[0]);
            // Escape columns
            const escapedColumns = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const sql = `INSERT IGNORE INTO ${table} (${escapedColumns}) VALUES (${placeholders})`;

            let count = 0;
            for (const row of rows) {
                const values = columns.map(c => row[c]);
                await pool.query(sql, values);
                count++;
            }
            console.log(`  Migrated ${count} rows into ${table}`);
        } catch (err) {
            console.error(`  Error migrating ${table}: ${err.message}`);
        }
    }

    // also migrate offers
    console.log("Connecting to SQLite (offers.db)...");
    const offersDb = new sqlite3.Database(offersPath);
    try {
        const rows = await getSqliteData(offersDb, `SELECT * FROM offers`);
        if (rows.length > 0) {
            const columns = Object.keys(rows[0]);
            const escapedColumns = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const sql = `INSERT IGNORE INTO offers (${escapedColumns}) VALUES (${placeholders})`;
            let count = 0;
            for (const row of rows) {
                const values = columns.map(c => row[c]);
                await pool.query(sql, values);
                count++;
            }
            console.log(`  Migrated ${count} rows into offers`);
        }
    } catch (err) {
        console.error(`  Error migrating offers: ${err.message}`);
    }

    console.log("Migration complete!");
    process.exit(0);
}

migrateData().catch(console.error);
