// controllers/orderController.js  (createOrder — replaces the restaurant version)
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import { generateReceiptForOrder } from "../utils/generateReceipt.js";
import { deductStockFIFO } from "../utils/productStock.js";

// @desc    Finalize a checkout: creates the order, deducts stock FIFO, generates receipt
// @route   POST /api/orders
// @access  Protected — cashier, branchManager, admin
export const createOrder = async (req, res) => {
  const { items, subtotal, branch, customer, customerName } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "Cart must have at least one item" });
  }

  try {
    // Deduct stock FIFO for every line — fails fast if any item is short
    for (const line of items) {
      if (!line.productId) continue; // manually-entered scan fallback
      const product = await Product.findById(line.productId);
      if (!product) return res.status(404).json({ message: `Product not found: ${line.productName}` });
      await deductStockFIFO(product, line.quantity);
    }

    const order = await Order.create({
      cashier: req.user._id,
      branch,
      items,
      subtotal,
      source: "staff",
      status: "completed",
      customer: customer || null,
      customerName: customerName || null,
    });

    const receipt = await generateReceiptForOrder(order);

    // Broadcasts to the Public Customer Display for this register —
    // same pattern as the kitchen's order:created event
    const io = req.app.get("io");
    io.to(`branch:${branch}`).emit("sale:created", { order, receipt });

    res.status(201).json({ order, receipt });
  } catch (error) {
    console.error("Error creating sale:", error.message);
    res.status(500).json({ message: "Failed to complete sale", error: error.message });
  }
};
