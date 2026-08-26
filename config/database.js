import mysql from 'mysql2/promise';
import path from "path";
import { fileURLToPath } from "url";
import { initializeSchema, seedDefaultData } from "../database/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let connection;

function formatParams(params = []) {
  return params.map(val => {
    if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)) {
      const d = new Date(val);
      if (!isNaN(d)) {
        return d.toISOString().slice(0, 19).replace('T', ' ');
      }
    }
    return val;
  });
}

function createPromiseSqliteWrapper(pool) {
  // We wrap the mysql query to match the sqlite3 promise interface we built
  return {
    all: async (sql, params = []) => {
      const [rows] = await pool.query(sql, formatParams(params));
      return rows;
    },
    get: async (sql, params = []) => {
      const [rows] = await pool.query(sql, formatParams(params));
      return rows[0] || null;
    },
    run: async (sql, params = []) => {
      // MySQL complains at 'BEGIN TRANSACTION', redirect to 'START TRANSACTION'
      if (sql.trim().toUpperCase() === 'BEGIN TRANSACTION') {
        sql = 'START TRANSACTION';
      }
      const [result] = await pool.query(sql, formatParams(params));
      return { lastID: result.insertId, changes: result.affectedRows };
    },
    exec: async (sql) => {
      // Split by ';' and run individually since mysql2 execute doesn't like multiple statements by default
      const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const stmt of statements) {
        await pool.query(stmt);
      }
    },
    close: (cb) => {
      pool.end().then(() => cb(null)).catch(err => cb(err));
    }
  };
}

export function openDatabase() {
  if (connection) {
    return connection;
  }

  // Create MySQL connection pool
  const pool = mysql.createPool({
    host: 'mysql-4363837-rusticcharmbydaaom633-76de.j.aivencloud.com',
    user: 'avnadmin',
    password: process.env.DB_PASSWORD,
    database: 'defaultdb',
    port: 19138,
    ssl: {
      rejectUnauthorized: false
    }
  });

  connection = createPromiseSqliteWrapper(pool);

  initializeSchema(connection)
    .then(() => seedDefaultData(connection))
    .catch((error) => {
      console.error("Failed to initialize MySQL schema:", error);
    });

  return connection;
}

export function closeDatabase() {
  return new Promise((resolve, reject) => {
    if (!connection) {
      resolve();
      return;
    }

    connection.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      connection = null;
      resolve();
    });
  });
}

export function getSqliteDb() {
  return openDatabase(); // Kept same name for compatibility
}
