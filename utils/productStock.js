// utils/productStock.js
import Product from "../models/Product.js";

// Deducts qtyToSell from the product's oldest batches first (FIFO), and
// returns exactly what it cost — a quantity-weighted average across however
// many batches the sale spanned. Callers should attach avgCostPerUnit onto
// the corresponding order/receipt line as costPriceAtSale.
export async function deductStockFIFO(product, qtyToSell) {
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

  if (remaining > 0) {
    throw new Error(`Insufficient stock for ${product.name}`);
  }

  product.batches = product.batches.filter((b) => b.quantity > 0);
  await product.save();

  return {
    totalCost,
    avgCostPerUnit: qtyToSell > 0 ? totalCost / qtyToSell : 0,
  };
}

// Reverses a FIFO deduction — adds each line's quantity back as a new batch
// at the unit price it was sold at, so cancelling a bill never silently
// loses stock. Used when a checkout is abandoned before any payment lands
// (cashier closed the payment popup, or the browser tab was closed).
export async function restockItems(items, note, restockedBy = null) {
  for (const line of items) {
    if (!line.productId) continue; // manually-entered fallback line, nothing to restock
    const product = await Product.findById(line.productId);
    if (!product) continue;
    product.batches.push({
      quantity: line.quantity,
      costPerUnit: line.unitPrice,
      expiryDate: null,
      receivedBy: restockedBy,
      supplierNote: note,
    });
    await product.save();
  }
}
