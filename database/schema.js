const schemaSql = `
CREATE TABLE IF NOT EXISTS restaurant_settings (
  id VARCHAR(255) PRIMARY KEY,
  \`key\` VARCHAR(255) NOT NULL UNIQUE,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_items (
  id VARCHAR(255) PRIMARY KEY,
  category_id VARCHAR(255),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DOUBLE NOT NULL DEFAULT 0,
  image_url TEXT,
  is_veg TINYINT(1) NOT NULL DEFAULT 1,
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  is_popular TINYINT(1) NOT NULL DEFAULT 0,
  prep_time INT,
  rating DOUBLE DEFAULT 0,
  metadata TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS menu_translations (
  id VARCHAR(255) PRIMARY KEY,
  menu_item_id VARCHAR(255) NOT NULL,
  language_code VARCHAR(50) NOT NULL,
  name VARCHAR(255),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE(menu_item_id, language_code),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tables (
  id VARCHAR(255) PRIMARY KEY,
  table_key VARCHAR(255) NOT NULL UNIQUE,
  table_number INT NOT NULL,
  area VARCHAR(255) NOT NULL,
  area_label VARCHAR(255),
  display_name VARCHAR(255),
  occupied TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(255) NOT NULL DEFAULT 'available',
  current_order_id VARCHAR(255),
  current_session_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(255) PRIMARY KEY,
  table_id VARCHAR(255),
  table_reference VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  customer_name VARCHAR(255),
  customer_phone VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(255) PRIMARY KEY,
  session_id VARCHAR(255),
  table_id VARCHAR(255),
  table_reference VARCHAR(255),
  table_number INT,
  table_area VARCHAR(255),
  table_label VARCHAR(255),
  order_number VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  order_source VARCHAR(255),
  total DOUBLE NOT NULL DEFAULT 0,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(255),
  payment_status VARCHAR(50) DEFAULT 'Unpaid',
  payment_method VARCHAR(50),
  discount_type VARCHAR(50),
  discount_value DOUBLE,
  discount_amount DOUBLE,
  final_total DOUBLE,
  waiter_id VARCHAR(255),
  waiter_name VARCHAR(255),
  accepted_at TIMESTAMP NULL,
  served_at TIMESTAMP NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id VARCHAR(255) PRIMARY KEY,
  order_id VARCHAR(255) NOT NULL,
  menu_item_id VARCHAR(255),
  name VARCHAR(255),
  quantity INT NOT NULL DEFAULT 1,
  price DOUBLE NOT NULL DEFAULT 0,
  special_instructions TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS waiters (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  pin VARCHAR(10),
  active TINYINT(1) NOT NULL DEFAULT 1,
  online TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS waiter_calls (
  id VARCHAR(255) PRIMARY KEY,
  order_id VARCHAR(255),
  table_id VARCHAR(255),
  table_reference VARCHAR(255),
  session_id VARCHAR(255),
  waiter_id VARCHAR(255),
  reason VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (waiter_id) REFERENCES waiters(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS kitchen_credentials (
  id VARCHAR(255) PRIMARY KEY,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_versions (
  id VARCHAR(255) PRIMARY KEY,
  version_number INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS printers (
  id VARCHAR(255) PRIMARY KEY,
  printer_name VARCHAR(255),
  connection_type VARCHAR(50) NOT NULL DEFAULT 'network',
  ip_address VARCHAR(255),
  port INT,
  paper_width VARCHAR(20) NOT NULL DEFAULT '80mm',
  copies INT NOT NULL DEFAULT 1,
  auto_cut TINYINT(1) NOT NULL DEFAULT 1,
  auto_print TINYINT(1) NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id VARCHAR(255) PRIMARY KEY,
  order_id VARCHAR(255),
  type VARCHAR(50) NOT NULL,
  printer_id VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  payload TEXT NOT NULL,
  is_test TINYINT(1) NOT NULL DEFAULT 0,
  created_by VARCHAR(255),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP NULL,
  printed_at TIMESTAMP NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_bill_splits (
  id VARCHAR(255) PRIMARY KEY,
  order_id VARCHAR(255) NOT NULL,
  bill_number INT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal DOUBLE NOT NULL DEFAULT 0,
  tax DOUBLE NOT NULL DEFAULT 0,
  total DOUBLE NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
`;

export async function initializeSchema(db) {
  if (!db || typeof db.exec !== "function") {
    console.warn("[schema] Skipping schema initialization: no db connection");
    return;
  }

  try {
    await db.exec(schemaSql);

    // In MySQL, to avoid errors on duplicate columns via ALTER TABLE, you usually handle it via information_schema or just suppress errors.
    const optionalColumns = [
      "ALTER TABLE orders ADD COLUMN order_source VARCHAR(255)",
      "ALTER TABLE orders ADD COLUMN description TEXT",
      "ALTER TABLE orders ADD COLUMN discount_mode VARCHAR(50)",
      "ALTER TABLE orders ADD COLUMN food_discount_percent DOUBLE",
      "ALTER TABLE orders ADD COLUMN alcohol_discount_percent DOUBLE",
      "ALTER TABLE orders ADD COLUMN food_discount_amount DOUBLE",
      "ALTER TABLE orders ADD COLUMN alcohol_discount_amount DOUBLE"
    ];
    for (const stmt of optionalColumns) {
      try {
        await db.exec(stmt);
      } catch (err) {
        if (!String(err.message).includes("Duplicate column name")) {
          // ignore duplicate columns
        }
      }
    }

    console.log("✓ Database schema initialized");

    const existing = await db.get("SELECT COUNT(*) as count FROM menu_versions");
    if (existing && existing.count === 0) {
      const id = "version-" + Date.now();
      await db.run("INSERT INTO menu_versions (id, version_number) VALUES (?, ?)", [id, 1]);
    }

    const printers = ["bill", "kot"];
    for (const printerId of printers) {
      // MYSQL INSERT IGNORE
      await db.run(
        "INSERT IGNORE INTO printers (id, printer_name, connection_type, paper_width, copies, auto_cut, auto_print) VALUES (?, ?, 'network', '80mm', 1, 1, 0)",
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
}
