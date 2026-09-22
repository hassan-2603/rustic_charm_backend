import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const [k, ...v] = line.trim().split('=');
    if (k && v.length > 0 && !process.env[k]) {
      process.env[k] = v.join('=').trim().replace(/^["']|["']$/g, '');
    }
  }
}

import { openDatabase } from '../config/database.js';
import { fetchMenuItemsFromDb, billPreview, addOrderItems } from '../services/adminService.js';
import { createOrder as customerCreateOrder } from '../services/customerService.js';
import { createPrintJob, getPrintJob } from '../services/printerService.js';

async function runTests() {
  console.log("=== Starting English KOT & Bill Verification Tests ===\n");
  const db = openDatabase();

  try {
    // ----------------------------------------------------
    // Test 1: fetchMenuItemsFromDb with 'ru' returns englishName
    // ----------------------------------------------------
    console.log("Test 1: fetchMenuItemsFromDb with Russian language returns englishName...");
    const menuItems = await fetchMenuItemsFromDb(db, "ru");
    const testMenuItem = menuItems.find((m) => m.id === "item-ylpqo1kzb");

    if (!testMenuItem) {
      throw new Error("Could not find test item 'item-ylpqo1kzb'");
    }
    console.log(`  Found item: ${testMenuItem.id}`);
    console.log(`  Localized name (ru): "${testMenuItem.name}"`);
    console.log(`  Canonical englishName: "${testMenuItem.englishName}"`);

    if (!testMenuItem.englishName) {
      throw new Error("FAIL: testMenuItem.englishName is missing!");
    }
    if (testMenuItem.englishName !== "Veg Szechuan Rice") {
      throw new Error(`FAIL: expected 'Veg Szechuan Rice', got '${testMenuItem.englishName}'`);
    }
    console.log("✓ Test 1 Passed: Menu items have canonical englishName!\n");

    // Clean any previous test orders
    await db.run("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_name IN ('Russian Tourist', 'Test Tourist'))");
    await db.run("DELETE FROM print_jobs WHERE order_id IN (SELECT id FROM orders WHERE customer_name IN ('Russian Tourist', 'Test Tourist'))");
    await db.run("DELETE FROM orders WHERE customer_name IN ('Russian Tourist', 'Test Tourist')");
    await db.run("UPDATE tables SET occupied = 0, current_order_id = NULL, current_session_id = NULL WHERE occupied = 1 AND current_order_id NOT IN (SELECT id FROM orders)");

    // ----------------------------------------------------
    // Test 2: customerCreateOrder saves English name in order_items
    // ----------------------------------------------------
    console.log("Test 2: customerCreateOrder with Russian cart item saves English name in order_items...");
    const tables = await db.all("SELECT table_key FROM tables LIMIT 2");
    const tableReference = tables[0]?.table_key || "deck-area-1";
    const testSessionId = `test-session-${Date.now()}`;

    // Simulate what the customer app sends when in Russian language
    const russianCart = [
      {
        menuItem: {
          id: "item-ylpqo1kzb",
          name: "Жареный рис по-сычуаньски", // Russian name
          englishName: "Veg Szechuan Rice",
          price: 220,
        },
        quantity: 2,
        specialInstructions: "Less spicy",
      },
    ];

    const orderResult = await customerCreateOrder(
      db,
      tableReference,
      russianCart,
      440,
      testSessionId,
      "Russian Tourist",
      "+79991234567"
    );

    console.log(`  Order created with ID: ${orderResult.id}, Number: ${orderResult.orderNumber}`);

    // Query order_items directly from DB
    const savedItems = await db.all(
      "SELECT id, menu_item_id, name, quantity, price FROM order_items WHERE order_id = ?",
      [orderResult.id]
    );

    console.log(`  Items saved in order_items table:`, savedItems);

    if (savedItems.length === 0) {
      throw new Error("FAIL: No order_items saved!");
    }
    if (savedItems[0].name !== "Veg Szechuan Rice") {
      throw new Error(`FAIL: Expected saved item name 'Veg Szechuan Rice', got '${savedItems[0].name}'`);
    }
    if (/[А-Яа-я]/.test(savedItems[0].name)) {
      throw new Error(`FAIL: Saved item name contains Cyrillic/Russian characters: '${savedItems[0].name}'`);
    }
    console.log("✓ Test 2 Passed: order_items name is strictly in English!\n");

    // ----------------------------------------------------
    // Test 3: KOT generation produces English-only payload
    // ----------------------------------------------------
    console.log("Test 3: KOT print job generation produces English-only payload...");
    // Ensure KOT printer is configured for test
    await db.run("UPDATE printers SET ip_address = '127.0.0.1', port = 9100, printer_name = 'TestKOT' WHERE id = 'kot'");

    const kotJobResult = await createPrintJob(db, {
      orderId: orderResult.id,
      type: "KOT",
      createdBy: "test_runner",
    });

    const kotJobs = Array.isArray(kotJobResult) ? kotJobResult : [kotJobResult];
    if (kotJobs.length === 0) throw new Error("FAIL: No KOT jobs generated!");

    const kotJob = await db.get("SELECT * FROM print_jobs WHERE id = ?", [kotJobs[0].id]);
    const kotPayload = JSON.parse(kotJob.payload).kot;
    console.log("  Generated KOT payload items:", kotPayload.items);

    for (const item of kotPayload.items) {
      if (/[А-Яа-я]/.test(item.name)) {
        throw new Error(`FAIL: KOT item contains Russian text: '${item.name}'`);
      }
      if (item.name !== "Veg Szechuan Rice") {
        throw new Error(`FAIL: Expected KOT item 'Veg Szechuan Rice', got '${item.name}'`);
      }
    }
    console.log("✓ Test 3 Passed: KOT payload strictly contains English names!\n");

    // ----------------------------------------------------
    // Test 4: Bill generation produces English-only payload
    // ----------------------------------------------------
    console.log("Test 4: Bill print job generation produces English-only payload...");
    await db.run("UPDATE printers SET ip_address = '127.0.0.1', port = 9100, printer_name = 'TestBill' WHERE id = 'bill'");

    const billJobResult = await createPrintJob(db, {
      orderId: orderResult.id,
      type: "BILL",
      createdBy: "test_runner",
    });

    const billJobs = Array.isArray(billJobResult) ? billJobResult : [billJobResult];
    if (billJobs.length === 0) throw new Error("FAIL: No Bill jobs generated!");

    const billJob = await db.get("SELECT * FROM print_jobs WHERE id = ?", [billJobs[0].id]);
    const billPayload = JSON.parse(billJob.payload).bill;
    console.log("  Generated Bill payload items:", billPayload.items);

    for (const item of billPayload.items) {
      if (/[А-Яа-я]/.test(item.name)) {
        throw new Error(`FAIL: Bill item contains Russian text: '${item.name}'`);
      }
      if (item.name !== "Veg Szechuan Rice") {
        throw new Error(`FAIL: Expected Bill item 'Veg Szechuan Rice', got '${item.name}'`);
      }
    }
    console.log("✓ Test 4 Passed: Bill payload strictly contains English names!\n");

    // ----------------------------------------------------
    // Test 5: billPreview produces English-only items
    // ----------------------------------------------------
    console.log("Test 5: billPreview produces English-only items...");
    const preview = await billPreview(db, orderResult.id);
    console.log("  billPreview items:", preview.items);

    for (const item of preview.items) {
      if (/[А-Яа-я]/.test(item.name)) {
        throw new Error(`FAIL: billPreview item contains Russian text: '${item.name}'`);
      }
      if (item.name !== "Veg Szechuan Rice") {
        throw new Error(`FAIL: Expected billPreview item 'Veg Szechuan Rice', got '${item.name}'`);
      }
    }
    console.log("✓ Test 5 Passed: billPreview items are strictly in English!\n");

    // ----------------------------------------------------
    // Test 6: Fallback when client sends ONLY Russian string without englishName or ID
    // ----------------------------------------------------
    console.log("Test 6: Fallback translation lookup when cart has Russian name without englishName...");
    const tableReference2 = tables[1]?.table_key || "deck-area-2";
    const fallbackCart = [
      {
        menuItem: {
          id: "", // missing ID
          name: "Жареный рис по-сычуаньски", // Russian translation that exists in menu_translations table
          price: 220,
        },
        quantity: 1,
      },
    ];

    const fallbackOrder = await customerCreateOrder(
      db,
      tableReference2,
      fallbackCart,
      220,
      `fallback-session-${Date.now()}`,
      "Test Tourist",
      ""
    );

    const fallbackItems = await db.all(
      "SELECT name FROM order_items WHERE order_id = ?",
      [fallbackOrder.id]
    );

    console.log("  Fallback items saved:", fallbackItems);
    for (const item of fallbackItems) {
      if (/[А-Яа-я]/.test(item.name)) {
        throw new Error(`FAIL: Fallback item contains Russian text: '${item.name}'`);
      }
    }
    console.log("✓ Test 6 Passed: Fallback translation lookup correctly resolved English name!\n");

    // Clean up test orders
    await db.run("DELETE FROM order_items WHERE order_id IN (?, ?)", [orderResult.id, fallbackOrder.id]);
    await db.run("DELETE FROM orders WHERE id IN (?, ?)", [orderResult.id, fallbackOrder.id]);
    await db.run("DELETE FROM print_jobs WHERE order_id IN (?, ?)", [orderResult.id, fallbackOrder.id]);
    console.log("Cleaned up test data.");

    console.log("\n=======================================================");
    console.log("ALL 6 TESTS PASSED SUCCESSFULLY! 🚀");
    console.log("=======================================================");
    process.exit(0);
  } catch (err) {
    console.error("\nTEST FAILED WITH ERROR:", err);
    process.exit(1);
  }
}

runTests();
