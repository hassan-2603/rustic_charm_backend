import test from "node:test";
import assert from "node:assert/strict";
import { calculateAuthoritativeBill } from "../services/billCalculationService.js";

const sampleSectionsConfig = {
  cat_food: "Food",
  cat_liquor: "Liquor",
  Starters: "Food",
  Mains: "Food",
  Beer: "Liquor",
  Cocktails: "Liquor",
};

test("TEST 1: One ₹400 item -> subtotal = ₹400, discount = ₹0, final = ₹400", () => {
  const order = { id: "ord-1", orderNumber: "RC-0001", tableLabel: "T1" };
  const items = [
    { id: "i1", name: "Butter Chicken", price: 400, quantity: 1, categoryId: "cat_food" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 400);
  assert.equal(result.discountAmount, 0);
  assert.equal(result.finalTotal, 400);
  assert.equal(result.foodTotal, 400);
  assert.equal(result.alcoholTotal, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 400);
  assert.equal(result.items[0].amount, 400);
  assert.equal(result.items[0].section, "Food");
});

test("TEST 2: Multiple items: ₹400 + ₹450 + ₹1350 -> subtotal = ₹2200", () => {
  const order = { id: "ord-2", orderNumber: "RC-0002" };
  const items = [
    { id: "i1", name: "Pork Masala Fry", price: 400, quantity: 1, categoryId: "cat_food" },
    { id: "i2", name: "Prawns Masala Fry", price: 450, quantity: 1, categoryId: "cat_food" },
    { id: "i3", name: "Platter", price: 1350, quantity: 1, categoryId: "cat_food" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 2200);
  assert.equal(result.discountAmount, 0);
  assert.equal(result.finalTotal, 2200);
  assert.equal(result.foodTotal, 2200);
  assert.equal(result.alcoholTotal, 0);
  assert.equal(result.items.length, 3);
});

test("TEST 3: Quantity: ₹400 × 2 -> subtotal = ₹800", () => {
  const order = { id: "ord-3" };
  const items = [
    { id: "i1", name: "Kingfisher Ultra", price: 400, quantity: 2, categoryId: "cat_liquor" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 800);
  assert.equal(result.alcoholTotal, 800);
  assert.equal(result.foodTotal, 0);
  assert.equal(result.finalTotal, 800);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].price, 400);
  assert.equal(result.items[0].amount, 800);
  assert.equal(result.items[0].section, "Liquor");
});

test("TEST 4: Food + liquor classification -> Verify foodTotal + alcoholTotal = total", () => {
  const order = { id: "ord-4" };
  const items = [
    { id: "i1", name: "Fish Curry", price: 650, quantity: 2, category: "Mains" }, // 1300 Food
    { id: "i2", name: "Garlic Naan", price: 120, quantity: 4, category: "Starters" }, // 480 Food
    { id: "i3", name: "Whiskey Sour", price: 450, quantity: 2, category: "Cocktails" }, // 900 Liquor
    { id: "i4", name: "Draught Beer", price: 250, quantity: 3, category: "Beer" }, // 750 Liquor
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.foodTotal, 1780);
  assert.equal(result.alcoholTotal, 1650);
  assert.equal(result.total, 3430);
  assert.equal(result.foodTotal + result.alcoholTotal, result.total);
  assert.equal(result.finalTotal, 3430);
  assert.equal(result.foodItems.length, 2);
  assert.equal(result.alcoholItems.length, 2);
});

test("TEST 5: Category discount: exact paise rounding", () => {
  // Food: ₹175 item, 15% discount -> 175 * 0.15 = 26.25 (2625 paise)
  // Alcohol: ₹320 item, 10% discount -> 320 * 0.10 = 32.00 (3200 paise)
  // Total discount: 26.25 + 32.00 = 58.25 (5825 paise)
  // Subtotal: 495.00
  // Final: 495.00 - 58.25 = 436.75
  const order = {
    id: "ord-5",
    discountMode: "category",
    foodDiscountPercent: 15,
    alcoholDiscountPercent: 10,
  };
  const items = [
    { id: "i1", name: "Appetizer", price: 175, quantity: 1, categoryId: "cat_food" },
    { id: "i2", name: "Cocktail", price: 320, quantity: 1, categoryId: "cat_liquor" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.foodTotal, 175);
  assert.equal(result.alcoholTotal, 320);
  assert.equal(result.total, 495);
  assert.equal(result.foodDiscountPercent, 15);
  assert.equal(result.alcoholDiscountPercent, 10);
  assert.equal(result.foodDiscountAmount, 26.25);
  assert.equal(result.alcoholDiscountAmount, 32);
  assert.equal(result.discountAmount, 58.25);
  assert.equal(result.finalTotal, 436.75);
  assert.equal(result.finalTotal, Number((result.total - result.discountAmount).toFixed(2)));
});

test("TEST 6: Fixed discount greater than subtotal -> capped at subtotal", () => {
  // ₹2200 bill + ₹3000 fixed discount -> discount = ₹2200, final = ₹0
  const order = {
    id: "ord-6",
    discountMode: "flat",
    discountAmount: 3000,
  };
  const items = [
    { id: "i1", name: "Steak", price: 1100, quantity: 2, categoryId: "cat_food" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 2200);
  assert.equal(result.discountAmount, 2200);
  assert.equal(result.finalTotal, 0);
  assert.equal(result.discountMode, "flat");
});

test("TEST 7: Negative quantity MUST REJECT", () => {
  const order = { id: "ord-7" };
  const items = [
    { id: "i1", name: "Item", price: 100, quantity: -1, categoryId: "cat_food" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(order, items, sampleSectionsConfig),
    /Invalid quantity/i
  );
});

test("TEST 8: Quantity = 0 MUST REJECT", () => {
  const order = { id: "ord-8" };
  const items = [
    { id: "i1", name: "Item", price: 100, quantity: 0, categoryId: "cat_food" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(order, items, sampleSectionsConfig),
    /Invalid quantity/i
  );
});

test("TEST 9: Fractional quantity MUST REJECT", () => {
  const order = { id: "ord-9" };
  const items = [
    { id: "i1", name: "Item", price: 100, quantity: 1.5, categoryId: "cat_food" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(order, items, sampleSectionsConfig),
    /Invalid quantity/i
  );
});

test("TEST 10: Negative price MUST REJECT", () => {
  const order = { id: "ord-10" };
  const items = [
    { id: "i1", name: "Item", price: -50, quantity: 1, categoryId: "cat_food" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(order, items, sampleSectionsConfig),
    /Invalid price/i
  );
});

test("TEST 11: Discount > 100% MUST REJECT", () => {
  const order = {
    id: "ord-11",
    discountMode: "category",
    foodDiscountPercent: 105,
  };
  const items = [
    { id: "i1", name: "Item", price: 100, quantity: 1, categoryId: "cat_food" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(order, items, sampleSectionsConfig),
    /Invalid foodDiscountPercent/i
  );
});

test("TEST 12: Negative discount MUST REJECT", () => {
  const orderCategory = {
    id: "ord-12a",
    discountMode: "category",
    foodDiscountPercent: -5,
  };
  const items = [
    { id: "i1", name: "Item", price: 100, quantity: 1, categoryId: "cat_food" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(orderCategory, items, sampleSectionsConfig),
    /Invalid foodDiscountPercent/i
  );

  const orderFlat = {
    id: "ord-12b",
    discountMode: "flat",
    discountAmount: -20,
  };

  assert.throws(
    () => calculateAuthoritativeBill(orderFlat, items, sampleSectionsConfig),
    /Invalid fixed discount amount/i
  );
});

test("TEST 13: Stale order.final_total MUST BE COMPLETELY IGNORED", () => {
  // Input: order.final_total = 1800, order.total = 1800
  // items: ₹1880, ₹320
  // Expected: total = ₹2200, finalTotal = ₹2200
  const order = {
    id: "ord-13",
    order_number: "RC-STALE-1",
    total: 1800,
    final_total: 1800,
    finalTotal: 1800,
  };
  const items = [
    { id: "i1", name: "Food Platter", price: 1880, quantity: 1, categoryId: "cat_food" },
    { id: "i2", name: "Cocktail", price: 320, quantity: 1, categoryId: "cat_liquor" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 2200);
  assert.equal(result.finalTotal, 2200);
  assert.equal(result.discountAmount, 0);
  assert.equal(result.foodTotal, 1880);
  assert.equal(result.alcoholTotal, 320);
});

test("TEST 14: Floating-point-sensitive values remain exact at paise precision", () => {
  // 3 × 19.99 = 59.97 (in float: 19.99 * 3 = 59.970000000000006)
  // 1 × 0.10 = 0.10
  // 1 × 0.20 = 0.20 (in float: 0.1 + 0.2 = 0.30000000000000004)
  // Total = 59.97 + 0.10 + 0.20 = 60.27
  const order = { id: "ord-14" };
  const items = [
    { id: "i1", name: "Item A", price: 19.99, quantity: 3, categoryId: "cat_food" },
    { id: "i2", name: "Item B", price: 0.1, quantity: 1, categoryId: "cat_food" },
    { id: "i3", name: "Item C", price: 0.2, quantity: 1, categoryId: "cat_food" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.items[0].price, 19.99);
  assert.equal(result.items[0].amount, 59.97);
  assert.equal(result.total, 60.27);
  assert.equal(result.finalTotal, 60.27);
});

test("TEST 15: Unresolvable bill section MUST FAIL CLOSED", () => {
  const order = { id: "ord-15" };
  const items = [
    { id: "i1", name: "Mystery Item", price: 100, quantity: 1, category: "UnconfiguredCategory" },
  ];

  assert.throws(
    () => calculateAuthoritativeBill(order, items, sampleSectionsConfig),
    /Unresolvable bill section/i
  );
});

test("CRITICAL INVARIANT TEST: Original Incident #RC-0594 Regression", () => {
  // Stale order.final_total = ₹1800 from concurrent modification
  // Items sum to ₹2200:
  // - Prawns Masala Fry: ₹450
  // - Item 2 (Platter): ₹1350
  // - Pork Masala Fry: ₹400
  // Result must be total = 2200, finalTotal = 2200, discountAmount = 0
  const order = {
    id: "ord-rc-0594",
    orderNumber: "RC-0594",
    tableLabel: "Table 15",
    total: 1800,
    final_total: 1800,
    finalTotal: 1800,
    discount_amount: 0,
    discountAmount: 0,
  };

  const items = [
    { id: "item-1", name: "Prawns Masala Fry", price: 450, quantity: 1, categoryId: "cat_food" },
    { id: "item-2", name: "Platter", price: 1350, quantity: 1, categoryId: "cat_food" },
    { id: "item-3", name: "Pork Masala Fry", price: 400, quantity: 1, categoryId: "cat_food" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.orderNumber, "RC-0594");
  assert.equal(result.tableLabel, "Table 15");
  assert.equal(result.total, 2200);
  assert.equal(result.finalTotal, 2200);
  assert.equal(result.discountAmount, 0);
  assert.equal(result.foodTotal, 2200);
  assert.equal(result.alcoholTotal, 0);
  // Stale 1800 value had zero influence!
  assert.notEqual(result.finalTotal, 1800);
});

test("Direct percentage discount mode test", () => {
  const order = {
    id: "ord-pct",
    discountType: "percent",
    discountValue: 10,
  };
  const items = [
    { id: "i1", name: "Dish", price: 200, quantity: 1, categoryId: "cat_food" },
    { id: "i2", name: "Drink", price: 300, quantity: 1, categoryId: "cat_liquor" },
  ];

  const result = calculateAuthoritativeBill(order, items, sampleSectionsConfig);

  assert.equal(result.total, 500);
  assert.equal(result.discountAmount, 50);
  assert.equal(result.finalTotal, 450);
  assert.equal(result.discountMode, "percent");
});
