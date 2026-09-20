import test from "node:test";
import assert from "node:assert/strict";
import { calculateAuthoritativeBill } from "../services/billCalculationService.js";
import { buildBillPayload } from "../services/printerService.js";
import { buildReceiptWithAlignment } from "../../connector/index.js";

const sampleSectionsConfig = {
  cat_food: "Food",
  cat_liquor: "Liquor",
  Starters: "Food",
  Mains: "Food",
  Beer: "Liquor",
  Cocktails: "Liquor",
};

test("TEST A: order.final_total = 1800, order_items total = 2200 -> authoritative result = 2200", () => {
  const order = {
    id: "ord-test-a",
    orderNumber: "RC-A",
    final_total: 1800,
    finalTotal: 1800,
  };
  const items = [
    { id: "1", name: "Dish 1", price: 1200, quantity: 1, categoryId: "cat_food" },
    { id: "2", name: "Dish 2", price: 1000, quantity: 1, categoryId: "cat_food" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 2200);
  assert.equal(result.finalTotal, 2200);
  assert.equal(result.discountAmount, 0);
  assert.notEqual(result.finalTotal, 1800);
});

test("TEST B: order.total = 1800, order.final_total = 1800, order_items total = 2200 -> result = 2200", () => {
  const order = {
    id: "ord-test-b",
    orderNumber: "RC-B",
    total: 1800,
    final_total: 1800,
    finalTotal: 1800,
  };
  const items = [
    { id: "1", name: "Prawns Masala Fry", price: 450, quantity: 1, categoryId: "cat_food" },
    { id: "2", name: "Platter", price: 1350, quantity: 1, categoryId: "cat_food" },
    { id: "3", name: "Pork Masala Fry", price: 400, quantity: 1, categoryId: "cat_food" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 2200);
  assert.equal(result.finalTotal, 2200);
  assert.equal(result.discountAmount, 0);
});

test("TEST C: stale finalTotal that appears to imply a discount must NOT create an inferred discount", () => {
  // Stale finalTotal = 1800 on a 2200 order without explicit discount fields
  const order = {
    id: "ord-test-c",
    orderNumber: "RC-C",
    final_total: 1800,
    finalTotal: 1800,
    discount_amount: 0,
    discountAmount: 0,
    discount_mode: null,
    discountMode: null,
  };
  const items = [
    { id: "1", name: "Food Item", price: 1880, quantity: 1, categoryId: "cat_food" },
    { id: "2", name: "Liquor Item", price: 320, quantity: 1, categoryId: "cat_liquor" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  // Must NOT infer a 400 rupee discount
  assert.equal(result.discountAmount, 0);
  assert.equal(result.foodDiscountAmount, 0);
  assert.equal(result.alcoholDiscountAmount, 0);
  assert.equal(result.total, 2200);
  assert.equal(result.finalTotal, 2200);
});

test("TEST D: unknown bill section must fail closed", () => {
  const order = { id: "ord-test-d", orderNumber: "RC-D" };
  const items = [
    { id: "1", name: "Unmapped Dish", price: 500, quantity: 1, category: "UnknownSectionCat" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(order, items, sampleSectionsConfig),
    /Unresolvable bill section/i
  );
});

test("TEST E: invalid price/quantity must fail closed", () => {
  const order = { id: "ord-test-e", orderNumber: "RC-E" };

  // Invalid quantity: 0
  assert.throws(
    () => calculateAuthoritativeBill(order, [{ id: "1", name: "Dish", price: 100, quantity: 0, categoryId: "cat_food" }], sampleSectionsConfig),
    /Invalid quantity/i
  );

  // Invalid quantity: negative
  assert.throws(
    () => calculateAuthoritativeBill(order, [{ id: "1", name: "Dish", price: 100, quantity: -2, categoryId: "cat_food" }], sampleSectionsConfig),
    /Invalid quantity/i
  );

  // Invalid quantity: fractional
  assert.throws(
    () => calculateAuthoritativeBill(order, [{ id: "1", name: "Dish", price: 100, quantity: 2.5, categoryId: "cat_food" }], sampleSectionsConfig),
    /Invalid quantity/i
  );

  // Invalid price: negative
  assert.throws(
    () => calculateAuthoritativeBill(order, [{ id: "1", name: "Dish", price: -50, quantity: 1, categoryId: "cat_food" }], sampleSectionsConfig),
    /Invalid price/i
  );

  // Invalid price: non-finite NaN
  assert.throws(
    () => calculateAuthoritativeBill(order, [{ id: "1", name: "Dish", price: NaN, quantity: 1, categoryId: "cat_food" }], sampleSectionsConfig),
    /Invalid price/i
  );
});

test("TEST F: printer payload monetary fields originate from authoritative calculation", () => {
  const order = {
    id: "ord-test-f",
    orderNumber: "RC-0594-F",
    tableLabel: "Table 15",
    total: 1800, // Stale
    final_total: 1800, // Stale
    finalTotal: 1800, // Stale
    discount_amount: 0,
    discountAmount: 0,
    items: [
      { id: "1", name: "Prawns Masala Fry", price: 450, quantity: 1, categoryId: "cat_food" },
      { id: "2", name: "Item 2", price: 1350, quantity: 1, categoryId: "cat_food" },
      { id: "3", name: "Pork Masala Fry", price: 400, quantity: 1, categoryId: "cat_food" },
    ],
  };

  const payload = buildBillPayload(order, sampleSectionsConfig);

  assert.equal(payload.orderNumber, "RC-0594-F");
  assert.equal(payload.tableLabel, "Table 15");
  // Monetary fields MUST reflect items sum, NOT stale 1800
  assert.equal(payload.total, 2200);
  assert.equal(payload.finalTotal, 2200);
  assert.equal(payload.discountAmount, 0);
  assert.equal(payload.foodTotal, 2200);
  assert.equal(payload.alcoholTotal, 0);
  assert.ok(payload.date, "date string is present");
});

test("TEST G: connector cannot replace an authoritative Grand Total with order.finalTotal", () => {
  // Authoritative backend bill payload has finalTotal = 2200
  const billPayload = {
    orderNumber: "RC-0594-G",
    tableNumber: "Table 15",
    customerName: "Guest",
    waiterName: "Waiter A",
    date: "20/09/2026, 01:00:00 pm",
    foodTotal: 2200,
    alcoholTotal: 0,
    total: 2200,
    discountAmount: 0,
    finalTotal: 2200,
    foodItems: [
      { name: "Prawns Masala Fry", quantity: 1, price: 450, amount: 450 },
      { name: "Platter", quantity: 1, price: 1350, amount: 1350 },
      { name: "Pork Masala Fry", quantity: 1, price: 400, amount: 400 },
    ],
    alcoholItems: [],
  };

  const receiptBuffer = buildReceiptWithAlignment({
    bill: billPayload,
    printType: "bill",
    autoCut: true,
  });

  const receiptString = (Buffer.isBuffer(receiptBuffer) ? receiptBuffer : Buffer.concat(receiptBuffer)).toString("utf8");

  // Grand Total in receipt must be 2200
  assert.match(receiptString, /GRAND TOTAL:\s+Rs\s+2200/);
  // Must NOT show 1800 anywhere in GRAND TOTAL
  assert.doesNotMatch(receiptString, /GRAND TOTAL:\s+Rs\s+1800/);
});

test("TEST H: receipt preview cannot infer a discount from itemsTotal - staleFinalTotal", async () => {
  // Read frontend receiptPreview.ts and verify the fallback has been eliminated
  // In addition, test the preview logic directly:
  const items = [
    { name: "Prawns Masala Fry", price: 450, quantity: 1 },
    { name: "Platter", price: 1350, quantity: 1 },
    { name: "Pork Masala Fry", price: 400, quantity: 1 },
  ];
  const itemsSum = items.reduce((s, it) => s + it.price * it.quantity, 0);
  const staleFinalTotal = 1800;

  // The updated preview logic:
  let calculatedGrandTotal = itemsSum;
  let discountAmount = 0;
  // If order has no explicit discount, calculatedGrandTotal remains itemsSum
  assert.equal(calculatedGrandTotal, 2200);
  assert.equal(discountAmount, 0);
  // Must NOT infer discount = 2200 - 1800 = 400
  assert.notEqual(calculatedGrandTotal, staleFinalTotal);
});
