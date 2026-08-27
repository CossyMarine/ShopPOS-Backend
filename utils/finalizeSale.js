// utils/finalizeSale.js
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Receipt from "../models/Receipt.js";
import AdminSettings from "../models/AdminSettings.js";
import { generateReceiptForOrder } from "./generateReceipt.js";
import { deductStockFIFO } from "./productStock.js";
import { buildOrderVat } from "./vat.js";
import { notFound, badRequest } from "./AppError.js";
import { loadLivePromotions, applyPromotionToLine } from "./promotionEngine.js";
import { creditCashback } from "./walletPayments.js";

// The single place a sale actually gets written to the database — shared by
// the live checkout endpoint (createOrder) and the offline batch-sync
// endpoint (syncOfflineOrders), so pricing, promo application, FIFO
// deduction and receipt generation can never drift between the two paths.
//
// clientSaleId is the idempotency key. If it's provided and an order with
// that key already exists, this returns the EXISTING order/receipt instead
// of processing anything again — this is what makes it safe for a flaky
// connection to retry the same sale as many times as it needs to.
//
// allowNegativeStock should only ever be true from the offline sync path —
// see the comment on deductStockFIFO for why.
//
// cashPayment: { amountPaid } — ONLY set for offline-synced sales. A cash
// sale is the one payment method that needs no live network step to
// actually happen (unlike M-Pesa STK push or till confirmation), so it's
// the only method offline mode supports. When present, the receipt is
// marked paid in the SAME transaction as its creation — mirroring exactly
// what payReceipt does for a live cash sale — instead of landing as an
// unpaid receipt waiting for a second online-only call that offline mode
// has no way to make.
export const finalizeSale = async ({
  items,
  branch,
  cashierId,
  customer,
  customerName,
  soldAt,
  shiftId,       // explicit shift id for offline sales; undefined = "look up whatever's open now" (live sale behavior)
  clientSaleId,
  allowNegativeStock = false,
  syncedFromOffline = false,
  cashPayment,   // { amountPaid } — offline sync only
  io,
}) => {
  if (!items || items.length === 0) {
    throw badRequest("Cart must have at least one item");
  }

  // Idempotent replay: same clientSaleId that already landed → hand back
  // what was already created, don't touch stock or payment a second time.
  if (clientSaleId) {
    const existing = await Order.findOne({ clientSaleId });
    if (existing) {
      const receipt = await Receipt.findOne({ order: existing._id });
      return { order: existing, receipt, isDuplicate: true, stockDiscrepancy: existing.stockDiscrepancy };
    }
  }

  const session = await mongoose.startSession();
  let order, receipt, stockDiscrepancy = false;

  try {
    await session.withTransaction(async () => {
      const settings = await AdminSettings.getSettings();
      const livePromotions = await loadLivePromotions(branch);

      for (const line of items) {
        if (!line.productId) {
          line.vatClass = "standard";
          continue;
        }
        const product = await Product.findById(line.productId).session(session);
        if (!product) throw notFound(`Product: ${line.productName}`);

        const { avgCostPerUnit, shortfall } = await deductStockFIFO(product, line.quantity, {
          session,
          allowNegative: allowNegativeStock,
        });
        if (shortfall > 0) stockDiscrepancy = true;

        line.costPriceAtSale = avgCostPerUnit;
        line.vatClass = product.vatClass || "standard";

        const priced = applyPromotionToLine(livePromotions, product, line.quantity, product.sellingPrice);
        line.originalUnitPrice = product.sellingPrice;
        line.unitPrice = priced.unitPrice;
        line.lineTotal = priced.lineTotal;
        line.promotionApplied = priced.promotionApplied;
        line.promotionName = priced.promotionName;
        line.discountAmount = priced.discountAmount;
      }

      const rungUpTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
      const { vatEnabled, vatRate, priceMode, subtotal, vatAmount, totalDue } = buildOrderVat(items, settings.vat);

      const created = await Order.create(
        [{
          cashier: cashierId,
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
          clientSaleId: clientSaleId || null,
          soldAt: soldAt ? new Date(soldAt) : new Date(),
          syncedFromOffline,
          stockDiscrepancy,
        }],
        { session }
      );
      order = created[0];

      receipt = await generateReceiptForOrder(order, { session, shift: shiftId });

      if (cashPayment) {
        const received = Number(cashPayment.amountPaid);
        const balanceDue = receipt.totalDue; // full amount — offline sales are never partial
        const changeGiven = Number((Math.max(received, balanceDue) - balanceDue).toFixed(2));

        receipt.status = "paid";
        receipt.paymentMethod = "cash";
        receipt.cashAmount = balanceDue;
        receipt.tillAmount = 0;
        receipt.amountPaid = receipt.totalDue;
        receipt.changeGiven = changeGiven;
        receipt.paidAt = order.soldAt; // the actual moment of sale, not sync time
        receipt.payments.push({
          amount: balanceDue,
          method: "cash",
          paidBy: cashierId,
          paidAt: order.soldAt,
        });

        await creditCashback(receipt, balanceDue, { session });
        await receipt.save({ session });
      }
    });
  } finally {
    await session.endSession();
  }

  if (io) {
    io.to(`branch:${branch}`).emit("sale:created", { order, receipt });
  }

  return { order, receipt, isDuplicate: false, stockDiscrepancy };
};
