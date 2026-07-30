// utils/productStock.js
export async function deductStockFIFO(product, qtyToSell) {
  let remaining = qtyToSell;
  product.batches.sort((a, b) => a.receivedAt - b.receivedAt); // oldest first

  for (const batch of product.batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    batch.quantity -= take;
    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error(`Insufficient stock for ${product.name}`);
  }

  product.batches = product.batches.filter((b) => b.quantity > 0);
  await product.save();
}
