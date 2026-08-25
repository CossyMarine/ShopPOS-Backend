// controllers/orderController.js  (createOrder — replaces the restaurant version)
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import AdminSettings from "../models/AdminSettings.js";
import { generateReceiptForOrder } from "../utils/generateReceipt.js";
import { deductStockFIFO } from "../utils/productStock.js";
import { buildOrderVat } from "../utils/vat.js";
import { notFound } from "../utils/AppError.js";

// @desc    Finalize a checkout: creates the order, deducts stock FIFO, generates receipt
// @route   POST /api/orders
// @access  Protected — cashier, branchManager, admin
export const createOrder = async (req, res, next) => {
  const { items, branch, customer, customerName } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "Cart must have at least one item" });
  }

  const session = await mongoose.startSession();
  let order, receipt;

  try {
    await session.withTransaction(async () => {
      const settings = await AdminSettings.getSettings();

      // Deduct stock FIFO for every line inside the transaction — if any
      // line fails (product not found, insufficient stock), everything
      // deducted so far in this loop is rolled back automatically when
      // withTransaction aborts. This is the fix for the "stock gone, no
      // order created" bug flagged earlier.
      for (const line of items) {
        if (!line.productId) {
          line.vatClass = "standard"; // manual scan fallback — no product to read from
          continue;
        }
        const product = await Product.findById(line.productId).session(session);
        if (!product) throw notFound(`Product: ${line.productName}`);
        const { avgCostPerUnit } = await deductStockFIFO(product, line.quantity, { session });
        line.costPriceAtSale = avgCostPerUnit;
        line.vatClass = product.vatClass || "standard";
      }

      const rungUpTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
      const { vatEnabled, vatRate, priceMode, subtotal, vatAmount, totalDue } = buildOrderVat(items, settings.vat);

      const created = await Order.create(
        [{
          cashier: req.user._id,
          branch,
          items,
          subtotal: settings.vat?.enabled ? subtotal : rungUpTotal,
          vatEnabled,
          vatRate,
          priceMode,
          vatAmount,
          totalDue,
          source: "staff",
          status: "completed",
          customer: customer || null,
          customerName: customerName || null,
        }],
        { session }
      );
      order = created[0];

      // generateReceiptForOrder does its own writes — it needs to accept
      // and use { session } too for this to be fully atomic. Check that
      // file before relying on this as airtight; if it doesn't take a
      // session yet, the receipt creation itself is still outside the
      // transaction boundary.
      receipt = await generateReceiptForOrder(order, { session });
    });
  } catch (error) {
    await session.endSession();
    return next(error);
  }
  await session.endSession();

  // Emit only after the transaction has actually committed — telling
  // clients about a sale that got rolled back would be worse than not
  // telling them in time.
  const io = req.app.get("io");
  io.to(`branch:${branch}`).emit("sale:created", { order, receipt });

  res.status(201).json({ order, receipt });
};
