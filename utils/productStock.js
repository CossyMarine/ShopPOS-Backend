// utils/productStock.js
import Product from "../models/Product.js";
import { badRequest } from "./AppError.js";

// Deducts qtyToSell from the product's oldest batches first (FIFO) and returns
// what it cost — a quantity-weighted average across the batches touched.
// Attach avgCostPerUnit to the order/receipt line as costPriceAtSale.
// Pass { session } when this is one step in a larger atomic operation.
// Pass { allowNegative: true } ONLY for offline-sync replay.
export async function deductStockFIFO(product, qtyToSell, { session, allowNegative = false } = {}) {
  const available = product.batches.reduce((s, b) => s + b.quantity, 0);
  let remaining = qtyToSell;
  let totalCost = 0;
  product.batches.sort((a, b) => a.receivedAt - b.receivedAt); // oldest first

  for (const batch of product.batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    batch.quantity -= take;
    totalCost += take * batch.costPerUnit;
    remaining -= take;
  }

  let shortfall = 0;
  if (remaining > 0) {
    if (!allowNegative) {
      throw badRequest(`Only ${available} of ${product.name} left in stock`);
    }
    const lastKnownCost = product.batches.length > 0
      ? product.batches[product.batches.length - 1].costPerUnit
      : product.sellingPrice;
    totalCost += remaining * lastKnownCost;
    shortfall = remaining;
    remaining = 0;
  }

  product.batches = product.batches.filter((b) => b.quantity > 0);
  await product.save({ session });

  return {
    totalCost,
    avgCostPerUnit: qtyToSell > 0 ? totalCost / qtyToSell : 0,
    shortfall,
  };
}

// The cost a restocked unit should carry. NEVER the selling price.
// 1) the cost captured at sale time, 2) the product's current weighted-average
// batch cost, 3) the newest batch's cost, 4) 0 as a last resort.
function resolveRestockCost(line, product) {
  const captured = Number(line.costPriceAtSale);
  if (line.costPriceAtSale != null && Number.isFinite(captured) && captured >= 0) {
    return captured;
  }

  const batches = product.batches || [];
  const totalQty = batches.reduce((s, b) => s + b.quantity, 0);
  if (totalQty > 0) {
    const totalCost = batches.reduce((s, b) => s + b.quantity * b.costPerUnit, 0);
    return totalCost / totalQty;
  }
  if (batches.length > 0) return batches[batches.length - 1].costPerUnit;
  return 0;
}

// Reverses a FIFO deduction — adds each line's quantity back as a new batch at
// the cost it was ORIGINALLY bought at, so cancelling or voiding a bill never
// changes the product's average cost.
export async function restockItems(items, note, restockedBy = null, { session } = {}) {
  for (const line of items) {
    if (!line.productId) continue; // manual fallback line, nothing to restock
    const product = await Product.findById(line.productId).session(session || null);
    if (!product) continue;

    product.batches.push({
      quantity: line.quantity,
      costPerUnit: resolveRestockCost(line, product),
      expiryDate: null,
      receivedBy: restockedBy,
      supplierNote: note,
    });
    await product.save({ session });
  }
}
