const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS restaurant_settings (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  category_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL DEFAULT 0,
  image_url TEXT,
  is_veg INTEGER NOT NULL DEFAULT 1 CHECK (is_veg IN (0,1)),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),
  is_popular INTEGER NOT NULL DEFAULT 0 CHECK (is_popular IN (0,1)),
  prep_time INTEGER,
  rating REAL DEFAULT 0,
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS menu_translations (
  id TEXT PRIMARY KEY,
  menu_item_id TEXT NOT NULL,
  language_code TEXT NOT NULL,
  name TEXT,
  description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(menu_item_id, language_code),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  table_key TEXT NOT NULL UNIQUE,
  table_number INTEGER NOT NULL,
  area TEXT NOT NULL,
  area_label TEXT,
  display_name TEXT,
  occupied INTEGER NOT NULL DEFAULT 0 CHECK (occupied IN (0,1)),
  status TEXT NOT NULL DEFAULT 'available',
  current_order_id TEXT,
  current_session_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  table_id TEXT,
  table_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','ended','closed')),
  customer_name TEXT,
  customer_phone TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  table_id TEXT,
  table_reference TEXT,
  table_number INTEGER,
  table_area TEXT,
  table_label TEXT,
  order_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Pending',
  order_source TEXT,
  total REAL NOT NULL DEFAULT 0,
  customer_name TEXT,
  customer_phone TEXT,
  payment_status TEXT DEFAULT 'Unpaid',
  payment_method TEXT,
  discount_type TEXT,
  discount_value REAL,
  discount_amount REAL,
  final_total REAL,
  waiter_id TEXT,
  waiter_name TEXT,
  accepted_at TEXT,
  served_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  menu_item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  special_instructions TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS waiters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS waiter_calls (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  table_id TEXT,
  table_reference TEXT,
  session_id TEXT,
  waiter_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (waiter_id) REFERENCES waiters(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS kitchen_credentials (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_versions (
  id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Restaurant-level printer configuration. One row per printer role
-- ('bill' | 'kot'). Configured ONCE by the admin; every waiter and admin
-- print button reads from these same rows via the backend -- never from a
-- device's own localStorage. last_seen_at is a heartbeat written by the
-- one restaurant-side print connector every time it polls for jobs, so
-- "READY" vs "OFFLINE" reflects whether the connector is actually alive,
-- not just whether settings were saved.
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY CHECK (id IN ('bill','kot')),
  printer_name TEXT,
  connection_type TEXT NOT NULL DEFAULT 'network' CHECK (connection_type IN ('network','windows')),
  ip_address TEXT,
  port INTEGER,
  paper_width TEXT NOT NULL DEFAULT '80mm' CHECK (paper_width IN ('58mm','80mm')),
  copies INTEGER NOT NULL DEFAULT 1,
  auto_cut INTEGER NOT NULL DEFAULT 1 CHECK (auto_cut IN (0,1)),
  auto_print INTEGER NOT NULL DEFAULT 0 CHECK (auto_print IN (0,1)),
  last_seen_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Centralized print-job queue. Waiter and Admin both create rows here
-- through the exact same service function -- neither ever talks to a
-- printer directly. The one restaurant-side connector polls this queue
-- over outbound HTTPS and reports results back, so the printer never has
-- to be reachable from the internet or from any individual device.
CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('BILL','KOT')),
  printer_id TEXT NOT NULL CHECK (printer_id IN ('bill','kot')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PRINTED','FAILED','CANCELLED')),
  payload TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  created_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  printed_at TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
`;

export async function initializeSchema(db) {
  if (!db || typeof db.exec !== "function") {
    console.warn("[schema] Skipping schema initialization: no db connection");
    return;
  }

  try {
    await db.exec(schemaSql);
    try {
      await db.run("ALTER TABLE orders ADD COLUMN order_source TEXT");
    } catch (err) {
      if (!String(err.message).includes("duplicate column name")) throw err;
    }

    // Category-wise discount support (Food vs Alcohol) alongside the
    // existing flat/percent discount columns. discount_mode distinguishes
    // a plain "direct amount" discount from a category-split discount.
    const discountColumns = [
      "ALTER TABLE orders ADD COLUMN discount_mode TEXT",
      "ALTER TABLE orders ADD COLUMN food_discount_percent REAL",
      "ALTER TABLE orders ADD COLUMN alcohol_discount_percent REAL",
      "ALTER TABLE orders ADD COLUMN food_discount_amount REAL",
      "ALTER TABLE orders ADD COLUMN alcohol_discount_amount REAL",
    ];
    for (const statement of discountColumns) {
      try {
        await db.run(statement);
      } catch (err) {
        if (!String(err.message).includes("duplicate column name")) throw err;
      }
    }

    console.log("✓ Database schema initialized");

    // Ensure there's at least one menu version
    const existing = await db.get("SELECT COUNT(*) as count FROM menu_versions");
    if (existing.count === 0) {
      const id = crypto.randomUUID?.() || `version-${Date.now()}`;
      await db.run(
        "INSERT INTO menu_versions (id, version_number) VALUES (?, ?)",
        [id, 1]
      );
    }

    // Ensure the two printer roles always exist as rows (unconfigured until
    // the admin fills them in via Settings) so GET /printers never has to
    // special-case a missing row.
    for (const printerId of ["bill", "kot"]) {
      await db.run(
        "INSERT OR IGNORE INTO printers (id, printer_name, connection_type, paper_width, copies, auto_cut, auto_print) VALUES (?, ?, 'network', '80mm', 1, 1, 0)",
        [printerId, printerId === "bill" ? "Bill Printer" : "KOT Printer"]
      );
    }
  } catch (err) {
    console.error("[schema] Error initializing schema:", err);
    throw err;
  }
}

export async function seedDefaultData(db) {
  if (!db || typeof db.all !== "function") {
    console.warn("[schema] Skipping seed: no db connection");
    return;
  }

  try {
    const categories = await db.all("SELECT COUNT(*) as count FROM categories");
    if (categories[0]?.count === 0) {
      console.log("[schema] Database is empty, skipping seed (data should be uploaded separately)");
    }
  } catch (err) {
    console.warn("[schema] Could not check seed status:", err);
  }
}
