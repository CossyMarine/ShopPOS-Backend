// utils/generateReceipt.js
import Counter from "../models/Counter.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";

export const generateReceiptForOrder = async (order, { customer } = {}) => {
  const counter = await Counter.findOneAndUpdate(
    { name: "bill" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const billId = `#B${counter.seq.toString().padStart(4, "0")}`;

  // Order.cashier is a direct ObjectId now — no name lookup needed
  const openShift = await Shift.findOne({ openedBy: order.cashier, status: "open" });

  const receipt = await Receipt.create({
    billId,
    order: order._id,
    shift: openShift ? openShift._id : null,
    branch: order.branch,
    cashierName: order.cashierName || null,
    source: order.source || "staff",
    items: order.items,
    subtotal: order.subtotal,
    customer: customer || order.customer || null,
  });

  return receipt;
};
