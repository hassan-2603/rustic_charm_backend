/**
 * Phase 3 Billing Integrity Tests
 * =================================
 * Tests the atomic bill finalization boundary introduced in Phase 3:
 *
 *  - requestBill() uses SELECT...FOR UPDATE + calculateAuthoritativeBill() to freeze the bill.
 *  - addOrderItems() / removeOrderItems() / updateOrderItemPrices() reject with 409 when the
 *    order is already in 'Bill Requested' state.
 *  - updateOrder() strips client-provided financial fields on a 'Bill Requested' order.
 *  - Status can still advance to 'Payment Done' / 'Completed' after bill finalization.
 *
 * These tests run in pure in-memory mode and never touch the production database.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { calculateAuthoritativeBill } from "../services/billCalculationService.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal in-memory DB mock — emulates the SQLite driver interface used by the
// service layer (db.get, db.all, db.run, db.transaction).
// ─────────────────────────────────────────────────────────────────────────────

function buildMockDb({ order, items, billSectionsConfig = {}, existingStatus = "Accepted" }) {
  const orderRow = {
    id: order.id,
    order_number: order.orderNumber || "RC-TEST",
    status: existingStatus,
    total: order.total ?? 0,
    final_total: order.final_total ?? order.finalTotal ?? null,
    discount_mode: order.discountMode ?? order.discount_mode ?? null,
    discount_type: order.discountType ?? order.discount_type ?? null,
    discount_value: order.discountValue ?? order.discount_value ?? null,
    discount_amount: order.discountAmount ?? order.discount_amount ?? null,
    food_discount_percent: order.foodDiscountPercent ?? order.food_discount_percent ?? null,
    alcohol_discount_percent: order.alcoholDiscountPercent ?? order.alcohol_discount_percent ?? null,
    table_label: order.tableLabel ?? "",
    table_number: order.tableNumber ?? "",
    table_reference: order.tableReference ?? "",
    waiter_name: order.waiterName ?? "",
    customer_name: order.customerName ?? "",
    customer_phone: order.customerPhone ?? "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const itemRows = items.map((item) => ({
    id: item.id,
    menu_item_id: item.menuItemId ?? item.id,
    name: item.name,
    quantity: item.quantity,
    price: item.price,
    category_name: item.category ?? "",
    category_id: item.categoryId ?? "",
  }));

  const configRow = Object.keys(billSectionsConfig).length > 0
    ? { value: JSON.stringify(billSectionsConfig) }
    : null;

  let lastWrite = null;

  const mockTx = {
    get: async (sql) => {
      if (sql.includes("orders")) return orderRow;
      if (sql.includes("restaurant_settings")) return configRow;
      return null;
    },
    all: async (sql) => {
      if (sql.includes("order_items")) return itemRows;
      return [];
    },
    run: async (sql, params) => {
      lastWrite = { sql, params };
    },
  };

  const mockDb = {
    all: async () => [],
    run: async () => {},
    get: async (sql) => {
      if (sql.includes("orders")) return orderRow;
      if (sql.includes("restaurant_settings")) return configRow;
      return null;
    },
    transaction: async (fn) => {
      await fn(mockTx);
    },
    _getLastWrite: () => lastWrite,
  };

  return { mockDb, orderRow, lastWrite: () => lastWrite };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers — simulate the exact service-layer logic being tested.
// ─────────────────────────────────────────────────────────────────────────────

async function simulateRequestBill(mockDb, orderId) {
  let frozenBill;
  let authTotal;
  let authFinalTotal;

  await mockDb.transaction(async (tx) => {
    let order;
    try {
      order = await tx.get(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [orderId]);
    } catch {
      order = await tx.get(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    }

    if (!order) {
      const err = new Error("Order not found");
      err.status = 404;
      throw err;
    }

    const nonBillableStatuses = ["Bill Requested", "Payment Done", "Completed", "Rejected"];
    if (nonBillableStatuses.includes(order.status)) {
      const err = new Error(`Cannot request bill for an order with status: ${order.status}`);
      err.status = 400;
      throw err;
    }

    const rawItems = await tx.all(
      `SELECT oi.id, oi.menu_item_id, oi.name, oi.quantity, oi.price,
              c.name AS category_name, c.id AS category_id
       FROM order_items oi
       LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
       LEFT JOIN categories  c  ON mi.category_id  = c.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    if (!rawItems || rawItems.length === 0) {
      const err = new Error("Cannot finalize a bill for an order with no items");
      err.status = 400;
      throw err;
    }

    const items = rawItems.map((row) => ({
      id: row.id,
      menuItemId: row.menu_item_id || "",
      name: row.name || "",
      quantity: Number(row.quantity || 0),
      price: Number(row.price || 0),
      category: row.category_name || "",
      categoryId: row.category_id || "",
    }));

    const configRow = await tx.get(
      "SELECT value FROM restaurant_settings WHERE `key` = 'bill_sections' LIMIT 1"
    );
    const config = configRow && configRow.value ? JSON.parse(configRow.value) : {};

    const normalizedOrder = {
      id: order.id,
      orderNumber: order.order_number,
      discountMode: order.discount_mode,
      discountType: order.discount_type,
      discountValue: order.discount_value,
      discountAmount: order.discount_amount !== null && order.discount_amount !== undefined ? Number(order.discount_amount) : null,
      foodDiscountPercent: order.food_discount_percent !== null && order.food_discount_percent !== undefined ? Number(order.food_discount_percent) : null,
      alcoholDiscountPercent: order.alcohol_discount_percent !== null && order.alcohol_discount_percent !== undefined ? Number(order.alcohol_discount_percent) : null,
    };

    frozenBill = calculateAuthoritativeBill(normalizedOrder, items, config);
    authTotal = frozenBill.total;
    authFinalTotal = frozenBill.finalTotal;

    await tx.run(
      `UPDATE orders SET status = 'Bill Requested', total = ?, final_total = ?, updated_at = ? WHERE id = ?`,
      [authTotal, authFinalTotal, new Date().toISOString(), orderId]
    );
  });

  return { total: authTotal, finalTotal: authFinalTotal, frozenBill };
}

async function simulateAddItemGuard(mockDb, orderId) {
  await mockDb.transaction(async (tx) => {
    let currentOrder;
    try {
      currentOrder = await tx.get(`SELECT * FROM orders WHERE id = ? FOR UPDATE`, [orderId]);
    } catch {
      currentOrder = await tx.get(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    }
    if (!currentOrder) throw new Error("Order not found");

    if (currentOrder.status === "Bill Requested") {
      const err = new Error(
        `Order ${currentOrder.order_number || orderId} has been finalized ('Bill Requested'). ` +
        `Items cannot be added after bill finalization.`
      );
      err.status = 409;
      throw err;
    }
  });
}

function simulateUpdateOrderGuard(currentStatus, updates) {
  const cloned = { ...updates };
  if (currentStatus === "Bill Requested") {
    const allowedTransitions = new Set(["Payment Done", "Completed"]);
    const requestedStatus = cloned.status;
    if (requestedStatus !== undefined && !allowedTransitions.has(requestedStatus)) {
      const err = new Error(
        `Order is already in 'Bill Requested' state. Status can only be advanced to 'Payment Done' or 'Completed'.`
      );
      err.status = 409;
      throw err;
    }
    const financialFields = [
      "total", "finalTotal", "discountAmount", "discountMode", "discountType",
      "discountValue", "foodDiscountPercent", "alcoholDiscountPercent",
      "foodDiscountAmount", "alcoholDiscountAmount",
    ];
    financialFields.forEach((f) => delete cloned[f]);
  }
  return cloned;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

const sampleSectionsConfig = {
  cat_food: "Food",
  cat_liquor: "Liquor",
  Starters: "Food",
  Mains: "Food",
  Beer: "Liquor",
};

test("P3-1: requestBill ignores stale orders.final_total and returns authoritative total", async () => {
  const order = {
    id: "ord-p3-1",
    orderNumber: "RC-P3-1",
    final_total: 1800,
    finalTotal: 1800,
    total: 1800,
  };
  const items = [
    { id: "i1", name: "Prawns Masala Fry", price: 450,  quantity: 1, categoryId: "cat_food" },
    { id: "i2", name: "Platter",           price: 1350, quantity: 1, categoryId: "cat_food" },
    { id: "i3", name: "Pork Masala Fry",   price: 400,  quantity: 1, categoryId: "cat_food" },
  ];

  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });
  const result = await simulateRequestBill(mockDb, order.id);

  assert.equal(result.total, 2200, "Total must be 2200 from items, not the stale 1800");
  assert.equal(result.finalTotal, 2200, "FinalTotal must be 2200 from items, not the stale 1800");
  assert.notEqual(result.total, 1800, "Must NOT return the stale value");
});

test("P3-2: requestBill RC-0594 regression — stale 1800 is rejected, correct total returned", async () => {
  const order = {
    id: "ord-rc-0594",
    orderNumber: "RC-0594",
    total: 1800,
    final_total: 1800,
    finalTotal: 1800,
  };
  const items = [
    { id: "i1", name: "Beer",            price: 320,  quantity: 1, categoryId: "cat_liquor" },
    { id: "i2", name: "Chicken",         price: 400,  quantity: 1, categoryId: "cat_food"   },
    { id: "i3", name: "Platter",         price: 1350, quantity: 1, categoryId: "cat_food"   },
    { id: "i4", name: "Pork Masala Fry", price: 400,  quantity: 1, categoryId: "cat_food"   },
  ];

  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });
  const result = await simulateRequestBill(mockDb, order.id);

  // 400 + 1350 + 400 = 2150 food; 320 liquor; total = 2470
  assert.equal(result.total, 2470, "Total must be 2470 from live items");
  assert.equal(result.finalTotal, 2470, "FinalTotal must be 2470 from live items");
  assert.notEqual(result.total, 1800, "Must NOT return stale 1800");
  assert.notEqual(result.finalTotal, 1800, "Must NOT return stale 1800");
});

test("P3-3: requestBill rejects order already in 'Bill Requested' status", async () => {
  const order = { id: "ord-p3-3", orderNumber: "RC-P3-3" };
  const items = [{ id: "i1", name: "Dish", price: 100, quantity: 1, categoryId: "cat_food" }];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig, existingStatus: "Bill Requested" });

  await assert.rejects(
    () => simulateRequestBill(mockDb, order.id),
    (err) => {
      assert.equal(err.status, 400);
      assert.ok(err.message.includes("Bill Requested"));
      return true;
    }
  );
});

test("P3-4: requestBill rejects order already in 'Payment Done' status", async () => {
  const order = { id: "ord-p3-4", orderNumber: "RC-P3-4" };
  const items = [{ id: "i1", name: "Dish", price: 100, quantity: 1, categoryId: "cat_food" }];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig, existingStatus: "Payment Done" });

  await assert.rejects(
    () => simulateRequestBill(mockDb, order.id),
    (err) => { assert.equal(err.status, 400); return true; }
  );
});

test("P3-5: requestBill rejects order with no items", async () => {
  const order = { id: "ord-p3-5", orderNumber: "RC-P3-5" };
  const { mockDb } = buildMockDb({ order, items: [], billSectionsConfig: sampleSectionsConfig });

  await assert.rejects(
    () => simulateRequestBill(mockDb, order.id),
    (err) => {
      assert.equal(err.status, 400);
      assert.ok(err.message.includes("no items"));
      return true;
    }
  );
});

test("P3-6: addOrderItems guard rejects with 409 on a Bill Requested order", async () => {
  const order = { id: "ord-p3-6", orderNumber: "RC-P3-6" };
  const items = [{ id: "i1", name: "Dish", price: 100, quantity: 1, categoryId: "cat_food" }];
  const { mockDb } = buildMockDb({ order, items, existingStatus: "Bill Requested" });

  await assert.rejects(
    () => simulateAddItemGuard(mockDb, order.id),
    (err) => {
      assert.equal(err.status, 409, `Expected HTTP 409, got ${err.status}`);
      assert.ok(err.message.includes("Bill Requested"));
      return true;
    }
  );
});

test("P3-7: addOrderItems does NOT guard an order in 'Accepted' status", async () => {
  const order = { id: "ord-p3-7", orderNumber: "RC-P3-7" };
  const items = [{ id: "i1", name: "Dish", price: 100, quantity: 1, categoryId: "cat_food" }];
  const { mockDb } = buildMockDb({ order, items, existingStatus: "Accepted" });

  await assert.doesNotReject(() => simulateAddItemGuard(mockDb, order.id));
});

test("P3-8: updateOrder strips financial fields on a Bill Requested order", () => {
  const updates = {
    status: "Payment Done",
    total: 9999,
    finalTotal: 9999,
    discountAmount: 500,
    discountMode: "flat",
    paymentMethod: "Cash",
    waiterName: "Ali",
  };

  const sanitized = simulateUpdateOrderGuard("Bill Requested", updates);

  assert.equal(sanitized.total, undefined, "total must be stripped");
  assert.equal(sanitized.finalTotal, undefined, "finalTotal must be stripped");
  assert.equal(sanitized.discountAmount, undefined, "discountAmount must be stripped");
  assert.equal(sanitized.discountMode, undefined, "discountMode must be stripped");
  assert.equal(sanitized.paymentMethod, "Cash", "paymentMethod must survive");
  assert.equal(sanitized.waiterName, "Ali", "waiterName must survive");
  assert.equal(sanitized.status, "Payment Done", "status must survive");
});

test("P3-9: updateOrder allows status advancement to 'Payment Done' on a Bill Requested order", () => {
  const updates = { status: "Payment Done", paymentMethod: "UPI" };
  assert.doesNotThrow(() => simulateUpdateOrderGuard("Bill Requested", updates));
});

test("P3-10: updateOrder allows status advancement to 'Completed' on a Bill Requested order", () => {
  const updates = { status: "Completed" };
  assert.doesNotThrow(() => simulateUpdateOrderGuard("Bill Requested", updates));
});

test("P3-11: updateOrder rejects disallowed backward status transition on a Bill Requested order", () => {
  const updates = { status: "Pending" };
  assert.throws(
    () => simulateUpdateOrderGuard("Bill Requested", updates),
    (err) => { assert.equal(err.status, 409); return true; }
  );
});

test("P3-12: updateOrder does not interfere when order is NOT in Bill Requested status", () => {
  const updates = { status: "Completed", total: 500, finalTotal: 450 };
  const result = simulateUpdateOrderGuard("Accepted", updates);
  assert.equal(result.total, 500, "total must survive on non-finalized order");
  assert.equal(result.finalTotal, 450, "finalTotal must survive on non-finalized order");
});

test("P3-13: requestBill correctly applies category discount before freezing", async () => {
  const order = {
    id: "ord-p3-13",
    orderNumber: "RC-P3-13",
    discount_mode: "category",
    food_discount_percent: 10,
    alcohol_discount_percent: 0,
  };
  const items = [
    { id: "i1", name: "Food Item", price: 1000, quantity: 1, categoryId: "cat_food"   },
    { id: "i2", name: "Beer",      price: 200,  quantity: 1, categoryId: "cat_liquor" },
  ];

  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });
  const result = await simulateRequestBill(mockDb, order.id);

  // Food: 1000 - 10% = 900; Liquor: 200; Final = 1100
  assert.equal(result.total, 1200, "Subtotal before discount must be 1200");
  assert.equal(result.finalTotal, 1100, "Final total after 10% food discount must be 1100");
  assert.equal(result.frozenBill.discountAmount, 100, "Discount must be Rs 100");
});

test("P3-14: frozenBill snapshot includes all line items with correct amounts", async () => {
  const order = { id: "ord-p3-14", orderNumber: "RC-P3-14" };
  const items = [
    { id: "i1", name: "Starter", price: 300, quantity: 2, categoryId: "cat_food"   },
    { id: "i2", name: "Beer",    price: 160, quantity: 1, categoryId: "cat_liquor" },
  ];

  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });
  const result = await simulateRequestBill(mockDb, order.id);

  assert.ok(result.frozenBill, "frozenBill must be returned");
  assert.equal(result.frozenBill.items.length, 2, "frozenBill must contain 2 items");
  const starter = result.frozenBill.items.find((i) => i.name === "Starter");
  assert.ok(starter, "Starter must be in frozen bill");
  assert.equal(starter.amount, 600, "Starter line amount must be 300 x 2 = 600");
  assert.equal(result.frozenBill.foodTotal, 600);
  assert.equal(result.frozenBill.alcoholTotal, 160);
  assert.equal(result.total, 760);
  assert.equal(result.finalTotal, 760);
});

test("P3-15: updateOrder does not strip status transition to 'Bill Requested' on a normal order", () => {
  const updates = { status: "Bill Requested", total: 500 };
  const result = simulateUpdateOrderGuard("Accepted", updates);
  assert.equal(result.status, "Bill Requested");
  assert.equal(result.total, 500);
});
