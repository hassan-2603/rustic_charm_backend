/**
 * Phase 4 Authoritative Bill Preview Tests
 * =========================================
 * Tests billPreview() service function and preview consistency guarantees:
 *
 *  1. Normal order calculation (food + alcohol split, subtotal, grand total).
 *  2. RC-0594 stale total regression: orders.total / orders.final_total are never
 *     consulted or trusted by preview.
 *  3. Category discount calculation (food % vs alcohol %).
 *  4. Flat discount calculation (including capping at subtotal).
 *  5. Percent discount calculation.
 *  6. Empty items rejection (HTTP 400, no_items).
 *  7. Invalid price / quantity rejection (HTTP 400).
 *  8. Internal consistency invariants (foodTotal + alcoholTotal === total, finalTotal === total - discount).
 *  9. Preview vs finalization consistency: unchanged order produces identical financial totals.
 * 10. Preview vs finalization after mutation: mutation between preview and finalization is reflected authoritatively.
 * 11. Already-finalized order: returns frozen_bill_json snapshot.
 * 12. Non-existent order: returns 404.
 *
 * Pure in-memory mock database — does not modify production database.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { billPreview } from "../services/adminService.js";
import { calculateAuthoritativeBill } from "../services/billCalculationService.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory mock DB helper
// ─────────────────────────────────────────────────────────────────────────────

function buildMockDb({ order, items = [], billSectionsConfig = {} }) {
  const orderRow = order
    ? {
        id: order.id,
        order_number: order.orderNumber || order.order_number || "RC-0001",
        status: order.status || "Accepted",
        total: order.total ?? 0,
        final_total: order.final_total ?? order.finalTotal ?? null,
        frozen_bill_json: order.frozen_bill_json ?? null,
        discount_mode: order.discountMode ?? order.discount_mode ?? null,
        discount_type: order.discountType ?? order.discount_type ?? null,
        discount_value: order.discountValue ?? order.discount_value ?? null,
        discount_amount: order.discountAmount ?? order.discount_amount ?? null,
        food_discount_percent: order.foodDiscountPercent ?? order.food_discount_percent ?? null,
        alcohol_discount_percent: order.alcoholDiscountPercent ?? order.alcohol_discount_percent ?? null,
        table_label: order.tableLabel ?? order.table_label ?? "Table 5",
        table_number: order.tableNumber ?? order.table_number ?? "5",
        table_reference: order.tableReference ?? order.table_reference ?? "T5",
        waiter_name: order.waiterName ?? order.waiter_name ?? "Alex",
        customer_name: order.customerName ?? order.customer_name ?? "Guest",
        customer_phone: order.customerPhone ?? order.customer_phone ?? "9876543210",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    : null;

  const itemRows = items.map((it, idx) => ({
    id: it.id || `item_${idx + 1}`,
    order_id: order?.id,
    menu_item_id: it.menuItemId || it.menu_item_id || `menu_${idx + 1}`,
    name: it.name || `Item ${idx + 1}`,
    quantity: it.quantity,
    price: it.price,
    category_name: it.category || it.category_name || "",
    category_id: it.categoryId || it.category_id || "",
    created_at: new Date(Date.now() + idx * 1000).toISOString(),
  }));

  const configRow = Object.keys(billSectionsConfig).length > 0
    ? { value: JSON.stringify(billSectionsConfig) }
    : null;

  const mockDb = {
    get: async (sql, params = []) => {
      if (/FROM orders/i.test(sql)) {
        if (!orderRow || orderRow.id !== params[0]) return null;
        return { ...orderRow };
      }
      if (/FROM restaurant_settings/i.test(sql)) {
        return configRow ? { ...configRow } : null;
      }
      return null;
    },
    all: async (sql, params = []) => {
      if (/FROM order_items/i.test(sql)) {
        if (!orderRow || orderRow.id !== params[0]) return [];
        return itemRows.map((r) => ({ ...r }));
      }
      return [];
    },
    run: async () => ({ changes: 1, lastID: 1 }),
    transaction: async (callback) => {
      return await callback(mockDb);
    },
  };

  return { mockDb, orderRow, itemRows };
}

const sampleSectionsConfig = {
  cat_starters: "Food",
  cat_mains: "Food",
  cat_desserts: "Food",
  cat_beverages: "Food",
  cat_beer: "Liquor",
  cat_wine: "Liquor",
  cat_cocktails: "Liquor",
  cat_spirits: "Liquor",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("1. Normal order bill preview produces correct food/liquor split, total, and finalTotal", async () => {
  const order = { id: "ord_1", orderNumber: "RC-001" };
  const items = [
    { id: "i1", name: "Paneer Tikka", price: 400, quantity: 1, categoryId: "cat_starters" },
    { id: "i2", name: "Butter Chicken", price: 450, quantity: 1, categoryId: "cat_mains" },
    { id: "i3", name: "Craft Beer", price: 450, quantity: 3, categoryId: "cat_beer" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  const preview = await billPreview(mockDb, "ord_1");

  assert.equal(preview.orderId, "ord_1");
  assert.equal(preview.foodTotal, 850);      // 400 + 450
  assert.equal(preview.alcoholTotal, 1350);  // 450 * 3
  assert.equal(preview.total, 2200);
  assert.equal(preview.discountAmount, 0);
  assert.equal(preview.finalTotal, 2200);
  assert.equal(preview.items.length, 3);
  assert.equal(preview.foodItems.length, 2);
  assert.equal(preview.alcoholItems.length, 1);
});

test("2. RC-0594 regression: stale orders.total / final_total does not contaminate bill preview", async () => {
  // Stale order row has ₹1,800 stored in DB columns from an earlier snapshot
  const order = {
    id: "ord_stale",
    orderNumber: "RC-0594",
    total: 1800,
    final_total: 1800,
  };
  const items = [
    { id: "i1", name: "Paneer Tikka", price: 400, quantity: 1, categoryId: "cat_starters" },
    { id: "i2", name: "Butter Chicken", price: 450, quantity: 1, categoryId: "cat_mains" },
    { id: "i3", name: "Craft Beer", price: 450, quantity: 3, categoryId: "cat_beer" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  const preview = await billPreview(mockDb, "ord_stale");

  // Must reflect true items sum (2200), NOT the stale 1800
  assert.equal(preview.total, 2200, "orders.total was ignored");
  assert.equal(preview.finalTotal, 2200, "orders.final_total was ignored");
  assert.notEqual(preview.total, 1800);
  assert.notEqual(preview.finalTotal, 1800);
});

test("3. Category discount preview: 10% on food, 0% on liquor", async () => {
  const order = {
    id: "ord_cat_disc",
    orderNumber: "RC-003",
    discountMode: "category",
    foodDiscountPercent: 10,
    alcoholDiscountPercent: 0,
  };
  const items = [
    { id: "i1", name: "Paneer Tikka", price: 400, quantity: 1, categoryId: "cat_starters" },
    { id: "i2", name: "Butter Chicken", price: 450, quantity: 1, categoryId: "cat_mains" },
    { id: "i3", name: "Craft Beer", price: 450, quantity: 3, categoryId: "cat_beer" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  const preview = await billPreview(mockDb, "ord_cat_disc");

  assert.equal(preview.foodTotal, 850);
  assert.equal(preview.alcoholTotal, 1350);
  assert.equal(preview.total, 2200);
  assert.equal(preview.foodDiscountAmount, 85);    // 10% of 850
  assert.equal(preview.alcoholDiscountAmount, 0);  // 0% of 1350
  assert.equal(preview.discountAmount, 85);
  assert.equal(preview.finalTotal, 2115);          // 2200 - 85
});

test("4. Flat discount preview: ₹200 off", async () => {
  const order = {
    id: "ord_flat_disc",
    orderNumber: "RC-004",
    discountMode: "flat",
    discountAmount: 200,
  };
  const items = [
    { id: "i1", name: "Paneer Tikka", price: 400, quantity: 1, categoryId: "cat_starters" },
    { id: "i2", name: "Butter Chicken", price: 450, quantity: 1, categoryId: "cat_mains" },
    { id: "i3", name: "Craft Beer", price: 450, quantity: 3, categoryId: "cat_beer" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  const preview = await billPreview(mockDb, "ord_flat_disc");

  assert.equal(preview.total, 2200);
  assert.equal(preview.discountAmount, 200);
  assert.equal(preview.finalTotal, 2000);
});

test("4b. Flat discount exceeding total is capped at total", async () => {
  const order = {
    id: "ord_flat_cap",
    orderNumber: "RC-004B",
    discountMode: "flat",
    discountAmount: 5000,
  };
  const items = [
    { id: "i1", name: "Dish", price: 500, quantity: 1, categoryId: "cat_mains" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  const preview = await billPreview(mockDb, "ord_flat_cap");

  assert.equal(preview.total, 500);
  assert.equal(preview.discountAmount, 500, "Capped at subtotal");
  assert.equal(preview.finalTotal, 0);
});

test("5. Percent discount preview: 10% off grand total", async () => {
  const order = {
    id: "ord_pct_disc",
    orderNumber: "RC-005",
    discountType: "percent",
    discountValue: 10,
  };
  const items = [
    { id: "i1", name: "Paneer Tikka", price: 400, quantity: 1, categoryId: "cat_starters" },
    { id: "i2", name: "Butter Chicken", price: 450, quantity: 1, categoryId: "cat_mains" },
    { id: "i3", name: "Craft Beer", price: 450, quantity: 3, categoryId: "cat_beer" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  const preview = await billPreview(mockDb, "ord_pct_disc");

  assert.equal(preview.total, 2200);
  assert.equal(preview.discountAmount, 220); // 10% of 2200
  assert.equal(preview.finalTotal, 1980);
});

test("6. Empty items rejects with HTTP 400 and no_items code", async () => {
  const order = { id: "ord_empty", orderNumber: "RC-EMPTY" };
  const { mockDb } = buildMockDb({ order, items: [] });

  await assert.rejects(
    async () => billPreview(mockDb, "ord_empty"),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, "no_items");
      return true;
    }
  );
});

test("7. Invalid item price / quantity rejects with HTTP 400", async () => {
  const order = { id: "ord_invalid", orderNumber: "RC-INV" };
  const items = [
    { id: "i1", name: "Invalid Item", price: -100, quantity: 1, categoryId: "cat_starters" },
  ];
  const { mockDb } = buildMockDb({ order, items });

  await assert.rejects(
    async () => billPreview(mockDb, "ord_invalid"),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test("8. Internal mathematical consistency invariants hold across all items", async () => {
  const order = {
    id: "ord_invar",
    orderNumber: "RC-INV01",
    discountMode: "category",
    foodDiscountPercent: 15,
    alcoholDiscountPercent: 5,
  };
  const items = [
    { id: "i1", name: "Dish 1", price: 199.50, quantity: 2, categoryId: "cat_mains" },
    { id: "i2", name: "Dish 2", price: 349.00, quantity: 1, categoryId: "cat_starters" },
    { id: "i3", name: "Beer 1", price: 280.00, quantity: 4, categoryId: "cat_beer" },
    { id: "i4", name: "Wine 1", price: 650.00, quantity: 2, categoryId: "cat_wine" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  const preview = await billPreview(mockDb, "ord_invar");

  // Every line item amount === price * quantity
  for (const it of preview.items) {
    assert.equal(it.amount, Math.round(it.price * it.quantity * 100) / 100);
  }

  // foodTotal === sum of Food items
  const expectedFood = preview.foodItems.reduce((s, it) => s + it.amount, 0);
  assert.equal(Math.round(preview.foodTotal * 100), Math.round(expectedFood * 100));

  // alcoholTotal === sum of Alcohol items
  const expectedAlcohol = preview.alcoholItems.reduce((s, it) => s + it.amount, 0);
  assert.equal(Math.round(preview.alcoholTotal * 100), Math.round(expectedAlcohol * 100));

  // total === foodTotal + alcoholTotal
  assert.equal(
    Math.round(preview.total * 100),
    Math.round((preview.foodTotal + preview.alcoholTotal) * 100)
  );

  // finalTotal === max(0, total - discountAmount)
  assert.equal(
    Math.round(preview.finalTotal * 100),
    Math.round(Math.max(0, preview.total - preview.discountAmount) * 100)
  );
});

test("9. Preview vs finalization consistency: unchanged order produces identical financial values", async () => {
  const order = {
    id: "ord_freeze_match",
    orderNumber: "RC-MATCH",
    discountMode: "category",
    foodDiscountPercent: 10,
    alcoholDiscountPercent: 5,
  };
  const items = [
    { id: "i1", name: "Biryani", price: 350, quantity: 2, categoryId: "cat_mains" },
    { id: "i2", name: "Beer", price: 300, quantity: 2, categoryId: "cat_beer" },
  ];
  const { mockDb } = buildMockDb({ order, items, billSectionsConfig: sampleSectionsConfig });

  // 1. Preview
  const preview = await billPreview(mockDb, "ord_freeze_match");

  // 2. Finalization (using the exact calculateAuthoritativeBill engine used by requestBill)
  const normalizedOrder = {
    id: order.id,
    orderNumber: order.orderNumber,
    discountMode: order.discountMode,
    foodDiscountPercent: order.foodDiscountPercent,
    alcoholDiscountPercent: order.alcoholDiscountPercent,
  };
  const finalized = calculateAuthoritativeBill(normalizedOrder, items, sampleSectionsConfig);

  // Preview and finalization MUST match exactly when order has not mutated
  assert.equal(preview.foodTotal, finalized.foodTotal);
  assert.equal(preview.alcoholTotal, finalized.alcoholTotal);
  assert.equal(preview.total, finalized.total);
  assert.equal(preview.foodDiscountAmount, finalized.foodDiscountAmount);
  assert.equal(preview.alcoholDiscountAmount, finalized.alcoholDiscountAmount);
  assert.equal(preview.discountAmount, finalized.discountAmount);
  assert.equal(preview.finalTotal, finalized.finalTotal);
});

test("10. Preview vs finalization after mutation: mutation is reflected authoritatively", async () => {
  const order = { id: "ord_mutate", orderNumber: "RC-MUT" };
  const initialItems = [
    { id: "i1", name: "Dish A", price: 400, quantity: 1, categoryId: "cat_starters" },
  ];
  const { mockDb, itemRows } = buildMockDb({ order, items: initialItems, billSectionsConfig: sampleSectionsConfig });

  // Initial preview before mutation
  const initialPreview = await billPreview(mockDb, "ord_mutate");
  assert.equal(initialPreview.finalTotal, 400);

  // Mutation: add Dish B (price 300)
  itemRows.push({
    id: "i2",
    order_id: "ord_mutate",
    menu_item_id: "m2",
    name: "Dish B",
    quantity: 1,
    price: 300,
    category_name: "Food",
    category_id: "cat_mains",
    created_at: new Date().toISOString(),
  });

  // Second preview after mutation
  const updatedPreview = await billPreview(mockDb, "ord_mutate");
  assert.equal(updatedPreview.finalTotal, 700);
  assert.notEqual(initialPreview.finalTotal, updatedPreview.finalTotal);

  // Finalize matches the updated preview
  const finalized = calculateAuthoritativeBill(
    { id: order.id, orderNumber: order.orderNumber },
    [
      { id: "i1", price: 400, quantity: 1, categoryId: "cat_starters" },
      { id: "i2", price: 300, quantity: 1, categoryId: "cat_mains" },
    ],
    sampleSectionsConfig
  );
  assert.equal(finalized.finalTotal, updatedPreview.finalTotal);
});

test("11. Already-finalized order with frozen_bill_json returns the frozen snapshot", async () => {
  const frozenSnapshot = {
    orderId: "ord_frozen",
    orderNumber: "RC-FROZEN",
    total: 1000,
    finalTotal: 900,
    foodTotal: 600,
    alcoholTotal: 400,
    discountAmount: 100,
    frozenAt: "2026-09-20T10:00:00Z",
  };
  const order = {
    id: "ord_frozen",
    status: "Bill Requested",
    frozen_bill_json: JSON.stringify(frozenSnapshot),
  };
  const { mockDb } = buildMockDb({ order, items: [] });

  const preview = await billPreview(mockDb, "ord_frozen");

  assert.equal(preview.finalTotal, 900);
  assert.equal(preview.frozenAt, "2026-09-20T10:00:00Z");
});

test("12. Non-existent order rejects with 404", async () => {
  const { mockDb } = buildMockDb({ order: null });

  await assert.rejects(
    async () => billPreview(mockDb, "ord_nonexistent"),
    (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /order not found/i);
      return true;
    }
  );
});

test("13. Missing orderId rejects with 400", async () => {
  const { mockDb } = buildMockDb({ order: null });

  await assert.rejects(
    async () => billPreview(mockDb, ""),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /order id is required/i);
      return true;
    }
  );
});
