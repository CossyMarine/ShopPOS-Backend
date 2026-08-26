// utils/productStock.js
import Product from "../models/Product.js";

// Deducts qtyToSell from the product's oldest batches first (FIFO), and
// returns exactly what it cost — a quantity-weighted average across however
// many batches the sale spanned. Callers should attach avgCostPerUnit onto
// the corresponding order/receipt line as costPriceAtSale.
//
// Pass { session } when this is one step in a larger atomic operation
// (checkout, void approval, stock adjustment approval) — the caller owns
// starting/committing/aborting the transaction; this function just
// participates in it.
//
// Pass { allowNegative: true } ONLY for offline-sync replay, never for a
// live checkout. A live sale can always trust the stock count it's reading
// right now, so insufficient stock there is a real, current problem and
// should hard-fail. An offline sale already happened in the real world —
// rung up, paid for, receipt printed — hours or days before it reaches the
// server, so by the time it syncs, another register may have legitimately
// sold the same units first. Rejecting it outright would mean losing a
// completed transaction from the books entirely. Instead, when allowed to
// go negative, the shortfall is costed at the last known batch price (or
// the average of whatever batches exist) and reported back to the caller,
// so the order can be flagged for manual stock reconciliation instead of
// silently vanishing or silently corrupting the count.
export async function deductStockFIFO(product, qtyToSell, { session, allowNegative = false } = {}) {
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
      throw new Error(`Insufficient stock for ${product.name}`);
    }
    // Cost the unmet portion at the most recent batch's price if any batches
    // exist at all, otherwise fall back to the product's current sellingPrice
    // so costPriceAtSale is never left as a nonsensical 0 for a real sale.
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
    shortfall, // > 0 means this sale pushed stock below zero — caller should flag it
  };
}

// Reverses a FIFO deduction — adds each line's quantity back as a new batch
// at the unit price it was sold at, so cancelling a bill never silently
// loses stock. Used when a checkout is abandoned before any payment lands,
// or when a void request is approved.
export async function restockItems(items, note, restockedBy = null, { session } = {}) {
  for (const line of items) {
    if (!line.productId) continue; // manually-entered fallback line, nothing to restock
    const product = await Product.findById(line.productId).session(session || null);
    if (!product) continue;
    product.batches.push({
      quantity: line.quantity,
      costPerUnit: line.unitPrice,
      expiryDate: null,
      receivedBy: restockedBy,
      supplierNote: note,
    });
    await product.save({ session });
  }
}
