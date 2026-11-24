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
//
// PACK LINES (carton / box / bale):
// A line may carry { packId, packCount }. The client only says "2 cartons";
// the server works out the rest from the product's own pack data:
//   - line.quantity  = packCount × pack.qty   (the ledger stays in PIECES, so
//                      FIFO stock, cost, profit, voids and analytics all keep
//                      working with no changes)
//   - line.lineTotal = packCount × pack price (the pack's own price, or
//                      pieces × piece price when the pack has no price),
//                      after any promotion — promotions apply per pack sold
//   - line.unitPrice = lineTotal ÷ pieces     (price per piece)
// packId / packName / packQty / packCount are kept on the line so receipts
// can show "2 × Carton of 12".
//
// PORTION LINES (½ kg, ¼ kg, half bar...):
// A line may carry { portionId, portionCount }. Same idea as packs, but for
// selling LESS than the base unit:
//   - line.quantity  = portionCount × portion.qty (BASE units, e.g. 2 × ¼ kg = 0.5 kg,
//                      so FIFO stock, cost and profit keep working unchanged)
//   - line.lineTotal = portionCount × portion price, after any promotion —
//                      promotions apply per portion sold
//   - line.unitPrice = lineTotal ÷ base units (price per base unit)
// portionId / portionName / portionQty / portionCount are kept on the line so
// receipts can show "2 × ¼ kg".
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

        // ---- Pack line: turn "N packs" into pieces ----
        let pack = null;
        let packCount = 0;
        if (line.packId) {
          packCount = Number(line.packCount);
          if (!Number.isInteger(packCount) || packCount < 1) {
            throw badRequest(`Invalid pack quantity for ${line.productName}`);
          }
          pack = (product.packs || []).find((k) => String(k._id) === String(line.packId)) || null;

          // A live sale must match a pack that exists right now. An offline
          // sale already happened, so if the pack was edited or removed
          // since, fall back to the pack size the till rang it up with.
          if (!pack && !syncedFromOffline) {
            throw badRequest(`${line.productName}: that pack no longer exists. Refresh the catalog and try again.`);
          }
          const packQty = pack ? pack.qty : Number(line.packQty);
          if (!(packQty > 1)) throw badRequest(`${line.productName}: invalid pack size`);

          line.packName = pack ? pack.name : line.packName;
          line.packQty = packQty;
          line.packCount = packCount;
          line.quantity = packCount * packQty; // the ledger stays in pieces
        }

        // ---- Portion line: "N portions" -> base units (e.g. 2 × ¼ kg = 0.5 kg) ----
        let portion = null;
        let portionCount = 0;
        if (line.portionId) {
          portionCount = Number(line.portionCount);
          if (!Number.isInteger(portionCount) || portionCount < 1) {
            throw badRequest(`Invalid portion quantity for ${line.productName}`);
          }
          portion = (product.portions || []).find((k) => String(k._id) === String(line.portionId)) || null;
          if (!portion && !syncedFromOffline) {
            throw badRequest(`${line.productName}: that portion no longer exists. Refresh the catalog and try again.`);
          }
          const portionQty = portion ? portion.qty : Number(line.portionQty);
          if (!(portionQty > 0)) throw badRequest(`${line.productName}: invalid portion size`);
          line.portionName = portion ? portion.name : line.portionName;
          line.portionQty = portionQty;
          line.portionCount = portionCount;
          line.quantity = Number((portionCount * portionQty).toFixed(3)); // ledger stays in BASE units
        }

        const { avgCostPerUnit, shortfall } = await deductStockFIFO(product, line.quantity, {
          session,
          allowNegative: allowNegativeStock,
        });
        if (shortfall > 0) stockDiscrepancy = true;

        line.costPriceAtSale = avgCostPerUnit;
        line.vatClass = product.vatClass || "standard";

        // A live sale prices off whatever's true RIGHT NOW — that's what
        // "live" means. An offline sale already happened at a specific
        // moment in the past; re-pricing it against promotions/prices that
        // are live NOW (at sync time, possibly days later) would silently
        // change what the customer was actually charged in the shop. So
        // offline-synced lines keep exactly the price they were rung up
        // at — only a genuinely live checkout gets the fresh server-side
        // promo/price computation.
        if (!syncedFromOffline) {
          if (pack) {
            // The pack's own price, or pieces × piece price when it has none.
            // A promotion applies per pack sold (a "KES 50 off" takes 50 off
            // each carton, not off each piece inside it).
            const packPrice = pack.price ?? pack.qty * product.sellingPrice;
            const priced = applyPromotionToLine(livePromotions, product, packCount, packPrice);
            line.originalUnitPrice = Number((packPrice / pack.qty).toFixed(4));            // per piece
            line.unitPrice = Number((priced.lineTotal / line.quantity).toFixed(4));        // per piece
            line.lineTotal = priced.lineTotal;                                             // exact pack total
            line.promotionApplied = priced.promotionApplied;
            line.promotionName = priced.promotionName;
            line.discountAmount = priced.discountAmount;
          } else if (portion) {
            // The portion's own price. Promotions apply per portion sold.
            const priced = applyPromotionToLine(livePromotions, product, portionCount, portion.price);
            line.originalUnitPrice = Number((portion.price / portion.qty).toFixed(4)); // per base unit
            line.unitPrice = Number((priced.lineTotal / line.quantity).toFixed(4));    // per base unit
            line.lineTotal = priced.lineTotal;
            line.promotionApplied = priced.promotionApplied;
            line.promotionName = priced.promotionName;
            line.discountAmount = priced.discountAmount;
          } else {
            const priced = applyPromotionToLine(livePromotions, product, line.quantity, product.sellingPrice);
            line.originalUnitPrice = product.sellingPrice;
            line.unitPrice = priced.unitPrice;
            line.lineTotal = priced.lineTotal;
            line.promotionApplied = priced.promotionApplied;
            line.promotionName = priced.promotionName;
            line.discountAmount = priced.discountAmount;
          }
        }
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
        const balanceDue = receipt.totalDue; // full amount — offline sales are never partial
        // Till leg is what the cashier said went to the till; the rest is cash.
        // (Older queued sales have no tillAmount, so they stay 100% cash.)
        const tillLeg = Math.min(Math.max(Number(cashPayment.tillAmount) || 0, 0), balanceDue);
        const cashLeg = Number((balanceDue - tillLeg).toFixed(2));
        const received = Number(cashPayment.cashAmount ?? cashPayment.amountPaid) || cashLeg;
        const changeGiven = cashLeg > 0 ? Number((Math.max(received, cashLeg) - cashLeg).toFixed(2)) : 0;

        receipt.status = "paid";
        receipt.paymentMethod = tillLeg > 0 && cashLeg > 0 ? "both" : tillLeg > 0 ? "manual_till" : "cash";
        receipt.cashAmount = cashLeg;
        receipt.tillAmount = tillLeg;
        receipt.amountPaid = receipt.totalDue;
        receipt.changeGiven = changeGiven;
        receipt.paidAt = order.soldAt; // the actual moment of sale, not sync time
        if (cashLeg > 0) receipt.payments.push({ amount: cashLeg, method: "cash", paidBy: cashierId, paidAt: order.soldAt });
        if (tillLeg > 0) receipt.payments.push({ amount: tillLeg, method: "manual_till", paidBy: cashierId, paidAt: order.soldAt });

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
