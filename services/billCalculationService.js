/**
 * Authoritative Bill Calculation Engine
 *
 * PURE calculation engine for billing integrity.
 * - Source of truth: order_items (quantity, price), authoritative discounts, and billSectionsConfig.
 * - Integer paise used internally for all intermediate arithmetic.
 * - Converts to rupees (2 decimal places) strictly for the returned payload.
 * - Zero side effects: no DB queries, no network calls, no mutation of input objects.
 * - Fail closed: rejects invalid quantities, invalid prices, invalid discounts, and unresolvable sections.
 * - NEVER consults orders.total, orders.final_total, or any other cached summary totals.
 */

/**
 * Converts integer paise to rupees with exact 2 decimal places precision.
 * @param {number} paise
 * @returns {number}
 */
function paiseToRupees(paise) {
  return Number((paise / 100).toFixed(2));
}

/**
 * Extracts a normalized category string from raw input (supports plain string or JSON object).
 * @param {any} raw
 * @returns {string}
 */
function extractCategoryString(raw) {
  if (!raw) return "";
  let val = raw;
  if (typeof val === "string" && val.trim().startsWith("{")) {
    try {
      val = JSON.parse(val);
    } catch {
      // keep as string
    }
  }
  if (typeof val === "object" && val !== null) {
    return String(
      val.English || val.en || val.Russian || val.ru || Object.values(val).find((v) => typeof v === "string" && v.trim()) || ""
    ).trim();
  }
  return String(val).trim();
}

/**
 * Normalizes section string strictly to "Food" or "Liquor".
 * Fails closed if the section is not recognized.
 * @param {string} rawSection
 * @param {any} item
 * @returns {"Food" | "Liquor"}
 */
function normalizeSection(rawSection, item) {
  if (typeof rawSection !== "string") {
    throw new Error(`Invalid section configuration for item "${item.name || item.id || "unknown"}": expected string, got ${typeof rawSection}`);
  }
  const clean = rawSection.trim().toLowerCase();
  if (clean === "food") {
    return "Food";
  }
  if (clean === "liquor" || clean === "alcohol") {
    return "Liquor";
  }
  throw new Error(`Unresolvable bill section "${rawSection}" for item "${item.name || item.id || "unknown"}": must be "Food" or "Liquor"`);
}

/**
 * Resolves an item's bill section using the authoritative billSectionsConfig.
 * FAIL CLOSED: If an item's classification cannot be resolved safely, throws an Error.
 * Does NOT guess or use hardcoded English category keywords.
 *
 * @param {object} item
 * @param {Record<string, string>} [billSectionsConfig]
 * @returns {"Food" | "Liquor"}
 */
function resolveItemSection(item, billSectionsConfig) {
  const config = billSectionsConfig && typeof billSectionsConfig === "object" ? billSectionsConfig : null;

  if (config) {
    // 1. Direct match by category ID
    const catId = item.categoryId || item.category_id;
    if (catId && config[catId] !== undefined) {
      return normalizeSection(config[catId], item);
    }

    // 2. Direct match by category Name
    const catName = extractCategoryString(item.category || item.category_name);
    if (catName && config[catName] !== undefined) {
      return normalizeSection(config[catName], item);
    }

    // 3. Case-insensitive category Name match in config
    if (catName) {
      const lowerCat = catName.toLowerCase();
      for (const [key, section] of Object.entries(config)) {
        if (extractCategoryString(key).toLowerCase() === lowerCat) {
          return normalizeSection(section, item);
        }
      }
    }

    // 4. Direct match by menu item ID if mapped in config
    const menuItemId = item.menuItemId || item.menu_item_id || item.id;
    if (menuItemId && config[menuItemId] !== undefined) {
      return normalizeSection(config[menuItemId], item);
    }
  }

  // 5. Pre-classified authoritative item section (if already provided and valid)
  if (item.section && typeof item.section === "string") {
    return normalizeSection(item.section, item);
  }

  // Fail closed: Classification cannot be resolved safely
  const itemIdentifier = item.name || item.id || item.menuItemId || "unknown";
  const catIdentifier = extractCategoryString(item.category || item.category_name) || item.categoryId || item.category_id || "none";
  throw new Error(`Unresolvable bill section for item "${itemIdentifier}" (category: "${catIdentifier}"). The item could not be classified via authoritative billSectionsConfig.`);
}

/**
 * Validates a discount percentage.
 * Must be a finite number >= 0 and <= 100.
 * @param {any} val
 * @param {string} fieldName
 * @returns {number}
 */
function validateDiscountPercent(val, fieldName) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 100) {
    throw new Error(`Invalid ${fieldName}: must be a finite number between 0 and 100, received ${val}`);
  }
  return val;
}

/**
 * Validates a fixed discount amount.
 * Must be a finite number >= 0.
 * @param {any} val
 * @param {string} fieldName
 * @returns {number}
 */
function validateFixedDiscount(val, fieldName = "discountAmount") {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
    throw new Error(`Invalid ${fieldName}: must be a finite number >= 0, received ${val}`);
  }
  return val;
}

/**
 * Pure calculation engine to compute an authoritative bill.
 *
 * @param {object} order - Order object containing metadata and discount fields
 * @param {Array<object>} [items] - Order items array (or order.items if omitted)
 * @param {Record<string, string>} [billSectionsConfig] - Classification map
 * @returns {object} Authoritative normalized bill calculation
 */
export function calculateAuthoritativeBill(order, items, billSectionsConfig) {
  // Support flexible call patterns:
  // - calculateAuthoritativeBill(order, items, billSectionsConfig)
  // - calculateAuthoritativeBill(order, billSectionsConfig) where order has .items
  // - calculateAuthoritativeBill({ order, items, billSectionsConfig })
  let orderObj = order;
  let itemsList = items;
  let sectionsConfig = billSectionsConfig;

  if (order && typeof order === "object" && !Array.isArray(order) && order.order && (order.items || order.billSectionsConfig)) {
    orderObj = order.order;
    itemsList = order.items !== undefined ? order.items : orderObj.items;
    sectionsConfig = order.billSectionsConfig !== undefined ? order.billSectionsConfig : billSectionsConfig;
  } else if (order && typeof order === "object" && !Array.isArray(order) && !Array.isArray(items) && typeof items === "object" && items !== null && !billSectionsConfig) {
    itemsList = order.items;
    sectionsConfig = items;
  }

  if (!orderObj || typeof orderObj !== "object") {
    throw new Error("Invalid order input: order must be an object");
  }

  const rawItems = Array.isArray(itemsList) ? itemsList : (Array.isArray(orderObj.items) ? orderObj.items : null);
  if (!rawItems || !Array.isArray(rawItems)) {
    throw new Error("Invalid items input: items must be an array");
  }

  const normalizedItems = [];
  const foodItems = [];
  const alcoholItems = [];

  let foodTotalPaise = 0;
  let alcoholTotalPaise = 0;

  // Process and validate every item individually (Fail Closed)
  for (let i = 0; i < rawItems.length; i++) {
    const rawItem = rawItems[i];
    if (!rawItem || typeof rawItem !== "object") {
      throw new Error(`Invalid item at index ${i}: item must be an object`);
    }

    // Validate quantity: integer and >= 1
    if (typeof rawItem.quantity !== "number" || !Number.isInteger(rawItem.quantity) || rawItem.quantity < 1) {
      throw new Error(`Invalid quantity for item "${rawItem.name || rawItem.id || `index ${i}`}": quantity must be an integer >= 1, received ${rawItem.quantity}`);
    }

    // Validate price: finite number and >= 0
    if (typeof rawItem.price !== "number" || !Number.isFinite(rawItem.price) || rawItem.price < 0) {
      throw new Error(`Invalid price for item "${rawItem.name || rawItem.id || `index ${i}`}": price must be a finite number >= 0, received ${rawItem.price}`);
    }

    // Integer paise calculations for item line
    const unitPricePaise = Math.round(rawItem.price * 100);
    const lineTotalPaise = unitPricePaise * rawItem.quantity;

    // Authoritative section resolution
    const section = resolveItemSection(rawItem, sectionsConfig);

    const normalizedItem = {
      id: rawItem.id !== undefined && rawItem.id !== null ? String(rawItem.id) : "",
      menuItemId: rawItem.menuItemId || rawItem.menu_item_id || "",
      name: String(rawItem.name || ""),
      quantity: rawItem.quantity,
      price: paiseToRupees(unitPricePaise),
      amount: paiseToRupees(lineTotalPaise),
      section,
    };

    normalizedItems.push(normalizedItem);

    if (section === "Food") {
      foodItems.push(normalizedItem);
      foodTotalPaise += lineTotalPaise;
    } else {
      alcoholItems.push(normalizedItem);
      alcoholTotalPaise += lineTotalPaise;
    }
  }

  const itemSubtotalPaise = foodTotalPaise + alcoholTotalPaise;

  // Authoritative Discount Calculation
  // Supports documented application modes: "category", "percent", "flat", or none.
  const rawDiscountMode = orderObj.discountMode ?? orderObj.discount_mode ?? null;
  const rawDiscountType = orderObj.discountType ?? orderObj.discount_type ?? null;

  let discountMode = null;
  let foodDiscountPercent = 0;
  let alcoholDiscountPercent = 0;
  let foodDiscountPaise = 0;
  let alcoholDiscountPaise = 0;
  let totalDiscountPaise = 0;

  const isCategoryDiscount = rawDiscountMode === "category";
  const isPercentDiscount = !isCategoryDiscount && (rawDiscountType === "percent" || rawDiscountMode === "percent");
  const hasExplicitFixedAmount = (orderObj.discountAmount !== undefined && orderObj.discountAmount !== null) ||
    (orderObj.discount_amount !== undefined && orderObj.discount_amount !== null);
  const isFlatDiscount = !isCategoryDiscount && !isPercentDiscount && (
    rawDiscountMode === "flat" || rawDiscountType === "flat" || (hasExplicitFixedAmount && (Number(orderObj.discountAmount || orderObj.discount_amount) > 0 || rawDiscountMode === "flat"))
  );

  if (isCategoryDiscount) {
    discountMode = "category";
    foodDiscountPercent = validateDiscountPercent(orderObj.foodDiscountPercent ?? orderObj.food_discount_percent, "foodDiscountPercent");
    alcoholDiscountPercent = validateDiscountPercent(orderObj.alcoholDiscountPercent ?? orderObj.alcohol_discount_percent, "alcoholDiscountPercent");

    foodDiscountPaise = Math.round((foodTotalPaise * foodDiscountPercent) / 100);
    alcoholDiscountPaise = Math.round((alcoholTotalPaise * alcoholDiscountPercent) / 100);
    totalDiscountPaise = foodDiscountPaise + alcoholDiscountPaise;
  } else if (isPercentDiscount) {
    discountMode = "percent";
    const rawPct = orderObj.discountValue ?? orderObj.discount_value ?? orderObj.discountPercent ?? orderObj.discount_percent ?? 0;
    const discountPercent = validateDiscountPercent(rawPct, "discountPercent");

    totalDiscountPaise = Math.round((itemSubtotalPaise * discountPercent) / 100);
  } else if (isFlatDiscount) {
    discountMode = "flat";
    const rawAmount = orderObj.discountAmount ?? orderObj.discount_amount ?? orderObj.discountValue ?? orderObj.discount_value ?? 0;
    const validatedFixedAmount = validateFixedDiscount(rawAmount, "fixed discount amount");
    const fixedDiscountPaise = Math.round(validatedFixedAmount * 100);

    // Capped at subtotal if greater than subtotal
    totalDiscountPaise = Math.min(fixedDiscountPaise, itemSubtotalPaise);
  } else if (rawDiscountMode === null || rawDiscountMode === undefined || rawDiscountMode === "") {
    // No discount applied
    discountMode = null;
    totalDiscountPaise = 0;
  } else {
    // Fail closed on unrecognized discount modes
    throw new Error(`Unrecognized discountMode "${rawDiscountMode}". Supported modes are "category", "flat", and "percent".`);
  }

  // Invariant: finalTotalPaise = max(0, itemSubtotalPaise - totalDiscountPaise)
  // Since totalDiscountPaise is capped at itemSubtotalPaise, this is always exact.
  // CRITICAL: orders.final_total or orders.total are NEVER consulted.
  const finalTotalPaise = Math.max(0, itemSubtotalPaise - totalDiscountPaise);

  const tableLabel = String(
    orderObj.tableLabel ||
    orderObj.table_label ||
    orderObj.tableNumber ||
    orderObj.table_number ||
    orderObj.tableReference ||
    orderObj.table_reference ||
    ""
  );

  return {
    orderId: String(orderObj.id || orderObj.orderId || ""),
    orderNumber: String(orderObj.orderNumber || orderObj.order_number || ""),
    tableLabel,
    tableNumber: tableLabel,
    waiterName: String(orderObj.waiterName || orderObj.waiter_name || ""),
    customerName: String(orderObj.customerName || orderObj.customer_name || ""),
    customerPhone: String(orderObj.customerPhone || orderObj.customer_phone || ""),
    calculatedAt: new Date().toISOString(),
    items: normalizedItems,
    foodItems,
    alcoholItems,
    foodTotal: paiseToRupees(foodTotalPaise),
    alcoholTotal: paiseToRupees(alcoholTotalPaise),
    total: paiseToRupees(itemSubtotalPaise),
    discountMode,
    foodDiscountPercent,
    alcoholDiscountPercent,
    foodDiscountAmount: paiseToRupees(foodDiscountPaise),
    alcoholDiscountAmount: paiseToRupees(alcoholDiscountPaise),
    discountAmount: paiseToRupees(totalDiscountPaise),
    finalTotal: paiseToRupees(finalTotalPaise),
  };
}

export default calculateAuthoritativeBill;
