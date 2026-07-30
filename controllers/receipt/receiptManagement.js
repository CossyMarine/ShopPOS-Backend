// controllers/receipt/receiptManagement.js
import Receipt from "../../models/Receipt.js";
import Order from "../../models/Order.js";
import Product from "../../models/Product.js";
import { deductStockFIFO } from "../../utils/productStock.js";

// @desc    Add items to an unpaid bill — e.g. a held/parked sale the cashier
//          is resuming, or a correction before the customer pays. Deducts
//          stock FIFO for the newly added items only (items already on the
//          bill were already deducted when the sale was first created).
// @route   PATCH /api/receipts/:id/items
// @access  Protected — cashier, branchManager, admin
export const addItemsToReceipt = async (req, res) => {
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "At least one item is required" });
  }

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Only unpaid bills can be added to" });
    }

    const now = new Date();

    // Always appended as their own line items rather than merged into an
    // existing line — keeps a clean, distinct audit trail of what was
    // added and when, even if an earlier line of the same product exists.
    const addedItems = items.map((incoming) => ({
      productId: incoming.productId || incoming._id || null,
      productName: incoming.productName,
      imageUrl: incoming.imageUrl || null,
      quantity: incoming.quantity,
      unitPrice: incoming.unitPrice,
      lineTotal: incoming.quantity * incoming.unitPrice,
      addedAt: now,
    }));

    // Deduct stock FIFO for the newly added items only
    for (const line of addedItems) {
      if (!line.productId) continue; // manually-entered fallback line
      const product = await Product.findById(line.productId);
      if (!product) return res.status(404).json({ message: `Product not found: ${line.productName}` });
      await deductStockFIFO(product, line.quantity);
    }

    const merged = [...receipt.items, ...addedItems];
    const subtotal = merged.reduce((sum, i) => sum + i.lineTotal, 0);

    receipt.items = merged;
    receipt.subtotal = subtotal;
    await receipt.save();

    const order = await Order.findByIdAndUpdate(receipt.order, { items: merged, subtotal }, { new: true });

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);
    if (order) {
      io.to(`branch:${receipt.branch}`).emit("order:updated", order);
      io.to(`branch:${receipt.branch}`).emit("order:itemsAdded", { order, receipt, addedItems });
    }

    res.json(receipt);
  } catch (error) {
    console.error("Error adding items to receipt:", error.message);
    res.status(500).json({ message: "Failed to add items", error: error.message });
  }
};

// @desc    Record that a receipt was (re)printed
// @route   PATCH /api/receipts/:id/print
// @access  Protected
export const markReceiptPrinted = async (req, res) => {
  try {
    const receipt = await Receipt.findByIdAndUpdate(
      req.params.id,
      { $inc: { printCount: 1 }, $set: { printedAt: new Date() } },
      { new: true }
    );
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json(receipt);
  } catch (error) {
    console.error("Error marking receipt printed:", error.message);
    res.status(500).json({ message: "Failed to update print status" });
  }
};
