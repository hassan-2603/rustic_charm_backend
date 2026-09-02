import sqlite3 from 'sqlite3';
import mysql from 'mysql2/promise';
import path from "path";
import { fileURLToPath } from "url";
import { initializeSchema, seedDefaultData } from "../database/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let connection;

function createPromiseSqliteWrapper(db) {
  return {
    all: (sql, params = []) => new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    }),
    get: (sql, params = []) => new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
    }),
    run: (sql, params = []) => new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    }),
    exec: (sql) => new Promise((resolve, reject) => {
      db.exec(sql, (err) => err ? reject(err) : resolve());
    }),
    close: (cb) => db.close(cb)
  };
}

export function openDatabase() {
  if (connection) {
    return connection;
  }

  // ==== SQLite Fallback ====
  // Restored local SQLite connection since the Aiven MySQL database went offline/unresolvable
  // Your data (menus, orders) is safe in this local file!
  /*
  const dbPath = path.join(__dirname, '..', 'database', 'rustic-charm.sqlite');
  const sqliteDb = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error("Failed to connect to SQLite:", err.message);
    } else {
      console.log("Connected to local SQLite database.");
    }
  });

  connection = createPromiseSqliteWrapper(sqliteDb);
  */

  // ==== MySQL Connection ====

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

  function createPromiseMysqlWrapper(pool) {
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
        if (sql.trim().toUpperCase() === 'BEGIN TRANSACTION') sql = 'START TRANSACTION';
        const [result] = await pool.query(sql, formatParams(params));
        return { lastID: result.insertId, changes: result.affectedRows };
      },
      exec: async (sql) => {
        const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
        for (const stmt of statements) await pool.query(stmt);
      },
      close: (cb) => pool.end().then(() => cb(null)).catch(err => cb(err))
    };
  }

  connection = createPromiseMysqlWrapper(pool);

  initializeSchema(connection)
    .then(() => seedDefaultData(connection))
    .catch((error) => {
      console.error("Failed to initialize schema:", error);
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
  return openDatabase();
}
