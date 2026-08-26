// utils/generateReceipt.js
import Counter from "../models/Counter.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import User from "../models/User.js";

// Pass { shift } explicitly for an offline-synced sale — the shift that was
// ACTUALLY open on the till when the sale happened, captured client-side at
// checkout time. Without this override, the fallback below looks up
// "whichever shift is open right now", which is correct for a live sale
// (same moment) but wrong for a sale syncing in hours later, possibly after
// a shift change — it would silently attribute the sale to the wrong
// shift and throw off shift reconciliation and shrinkage reporting.
export const generateReceiptForOrder = async (order, { customer, session, shift } = {}) => {
  const counter = await Counter.findOneAndUpdate(
    { name: "bill" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session }
  );
  const billId = `#B${counter.seq.toString().padStart(4, "0")}`;

  const resolvedShiftId = shift !== undefined
    ? shift
    : (await Shift.findOne({ openedBy: order.cashier, status: "open" }).session(session || null))?._id || null;

  // Order only stores the cashier's ObjectId now — resolve the actual name here
  const cashierUser = await User.findById(order.cashier).select("fullName").session(session || null);

  const created = await Receipt.create(
    [{
      billId,
      order: order._id,
      shift: resolvedShiftId,
      branch: order.branch,
      cashierName: cashierUser?.fullName || "Unknown",
      source: order.source || "staff",
      items: order.items,
      subtotal: order.subtotal,
      vatEnabled: order.vatEnabled,
      vatRate: order.vatRate,
      priceMode: order.priceMode,
      vatAmount: order.vatAmount,
      totalDue: order.totalDue,
      customer: customer || order.customer || null,
    }],
    { session }
  );

  return created[0];
};
