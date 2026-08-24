// controllers/orderController.js  (createOrder — replaces the restaurant version)
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

  try {
    const settings = await AdminSettings.getSettings();

    // Deduct stock FIFO for every line — fails fast if any item is short.
    // Mutates each line in place with its real cost-at-sale and vatClass, so
    // `items` (passed straight into Order.create below) carries both through.
    //
    // ⚠️ KNOWN ISSUE (not fixed in this pass): if this loop fails partway
    // (e.g. product not found on line 3 of 5), stock already deducted for
    // earlier lines is NOT rolled back — the order is never created, but
    // that inventory is gone. Needs a Mongoose transaction wrapping this
    // loop + Order.create below. See utils/productStock.js.
    for (const line of items) {
      if (!line.productId) {
        line.vatClass = "standard"; // manual scan fallback — no product to read from
        continue;
      }
      const product = await Product.findById(line.productId);
      if (!product) return next(notFound(`Product: ${line.productName}`));
      const { avgCostPerUnit } = await deductStockFIFO(product, line.quantity);
      line.costPriceAtSale = avgCostPerUnit;
      line.vatClass = product.vatClass || "standard";
    }

    // subtotal here is always the sum of line totals as rung up — buildOrderVat
    // decides whether that's net-of-VAT or VAT-inclusive based on priceMode,
    // and returns the authoritative figures to store.
    const rungUpTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const { vatEnabled, vatRate, priceMode, subtotal, vatAmount, totalDue } = buildOrderVat(items, settings.vat);

    const order = await Order.create({
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
    });

    const receipt = await generateReceiptForOrder(order);

    // Broadcasts to the Public Customer Display for this register —
    // same pattern as the kitchen's order:created event
    const io = req.app.get("io");
    io.to(`branch:${branch}`).emit("sale:created", { order, receipt });

    res.status(201).json({ order, receipt });
  } catch (error) {
    next(error);
  }
};
