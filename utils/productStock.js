// utils/productStock.js

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
