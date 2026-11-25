// controllers/creditController.js
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import Branch from "../models/Branch.js";
import CreditRecord from "../models/CreditRecord.js";
import { creditCashback } from "../utils/walletPayments.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";
import { notFound, badRequest, forbidden } from "../utils/AppError.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

const round2 = (n) => Number(Number(n).toFixed(2));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The "credit" entry in receipt.payments records the sale, not money received.
// Anything summing money collected must skip it.
const isMoneyEntry = (p) => p.method !== "credit";

// "2026-12-05" -> end of that day in Kenya time, so a bill is only
// "overdue" once the whole due day has passed.
const parseDueDate = (value) => {
  if (!value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T23:59:59.999+03:00`)
    : new Date(value);
  if (isNaN(d.getTime())) throw badRequest("Invalid pay date");
  return d;
};

const assertBranchAccess = (req, branchId) => {
  if (req.user?.isAdmin) return;
  if (String(req.user?.branch) !== String(branchId)) throw forbidden("You can only access your own branch");
};

// ============================================================
// CASHIER: put a bill on credit
// @route PATCH /api/receipts/:id/pay/credit
// ============================================================
export const payOnCredit = async (req, res, next) => {
  const { id } = req.params;
  const { customerName, customerPhone, dueDate, note } = req.body;
  let session, receipt, record;

  try {
    logStart("credit", "Putting bill on credit", { receiptId: id });
    const name = String(customerName || "").trim();
    if (!name) return res.status(400).json({ message: "Customer name is required for credit" });
    const due = parseDueDate(dueDate);

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      receipt = await Receipt.findById(id).session(session);
      if (!receipt) throw notFound("Receipt");
      assertBranchAccess(req, receipt.branch);

      const branch = await Branch.findById(receipt.branch).select("allowCredit").session(session);
      if (!branch?.allowCredit) throw forbidden("Credit is not enabled for this branch");

      if (receipt.status !== "unpaid" || (receipt.amountPaid || 0) > 0) {
        throw badRequest("Only a fully unpaid bill can be put on credit");
      }

      const givenAt = new Date();

      if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
      receipt.status = "credit";
      receipt.paymentMethod = "credit";
      receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;

      // The sale: recorded as a "credit" payment entry for the full bill, and
      // dated today so revenue/profit/items land on the day the goods left.
      // amountPaid is left alone — no money has been received yet.
      receipt.payments.push({
        amount: receipt.totalDue,
        method: "credit",
        reference: `Credit — ${name}`,
        paidBy: req.user?._id || null,
        paidAt: givenAt,
      });
      receipt.paidAt = givenAt;

      await receipt.save({ session });

      // Goods have left the shop, so the order is complete (stock was already deducted).
      await Order.findByIdAndUpdate(receipt.order, { status: "completed" }, { session });

      [record] = await CreditRecord.create(
        [{
          receipt: receipt._id,
          billId: receipt.billId,
          branch: receipt.branch,
          customerName: name,
          customerPhone: String(customerPhone || "").trim() || null,
          dueDate: due,
          amount: receipt.totalDue,
          cashierName: receipt.cashierName || req.user?.fullName || null,
          createdBy: req.user?._id || null,
        }],
        { session }
      );
    });
  } catch (error) {
    if (session) await session.endSession();
    return next(error);
  }
  await session.endSession();

  const io = req.app.get("io");
  io?.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);
  io?.emit("credit:created", record);

  logSuccess("credit", "Bill put on credit", { billId: receipt.billId, customer: record.customerName });
  res.json({ message: "Credit recorded", receipt, credit: record });
};

// ============================================================
// ADMIN: list credit records
// @route GET /api/credits?status=&q=&overdue=&branch=&page=&limit=
// ============================================================
export const getCredits = async (req, res, next) => {
  try {
    const { status = "outstanding", q, branch, overdue } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 15));

    const filter = {};
    if (branch) filter.branch = branch;

    if (overdue === "true") {
      filter.status = { $in: ["open", "partial"] };
      filter.dueDate = { $ne: null, $lt: new Date() };
    } else if (status === "outstanding") {
      filter.status = { $in: ["open", "partial"] };
    } else if (status && status !== "all") {
      filter.status = status;
    }

    if (q && q.trim()) {
      const rx = new RegExp(escapeRegex(q.trim()), "i");
      filter.$or = [{ customerName: rx }, { billId: rx }, { customerPhone: rx }];
    }

    const [total, credits] = await Promise.all([
      CreditRecord.countDocuments(filter),
      CreditRecord.find(filter)
        .populate("branch", "name")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    res.json({ credits, page, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/credits/summary?branch=
export const getCreditSummary = async (req, res, next) => {
  try {
    const branchMatch = req.query.branch
      ? { branch: new mongoose.Types.ObjectId(req.query.branch) }
      : {};
    const { start, end } = getKenyanDayBounds();
    const now = new Date();
    const owing = { $subtract: ["$amount", "$amountPaid"] };
    const isOverdue = { $and: [{ $ne: ["$dueDate", null] }, { $lt: ["$dueDate", now] }] };

    const [open, given] = await Promise.all([
      CreditRecord.aggregate([
        { $match: { status: { $in: ["open", "partial"] }, ...branchMatch } },
        {
          $group: {
            _id: null,
            outstanding: { $sum: owing },
            count: { $sum: 1 },
            overdue: { $sum: { $cond: [isOverdue, owing, 0] } },
            overdueCount: { $sum: { $cond: [isOverdue, 1, 0] } },
          },
        },
      ]),
      CreditRecord.aggregate([
        { $match: { status: { $ne: "voided" }, createdAt: { $gte: start, $lte: end }, ...branchMatch } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      outstanding: round2(open[0]?.outstanding || 0),
      outstandingCount: open[0]?.count || 0,
      overdue: round2(open[0]?.overdue || 0),
      overdueCount: open[0]?.overdueCount || 0,
      givenToday: round2(given[0]?.total || 0),
      givenTodayCount: given[0]?.count || 0,
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// ADMIN: record a settlement (full or part payment)
// @route POST /api/credits/:id/settle   { amount, method, reference }
// ============================================================
export const settleCredit = async (req, res, next) => {
  const { id } = req.params;
  const { amount, method, reference } = req.body;
  let session, record, receipt, fullyPaid = false;

  try {
    logStart("credit", "Recording credit settlement", { creditId: id, amount, method });

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      record = await CreditRecord.findById(id).session(session);
      if (!record) throw notFound("Credit record");
      assertBranchAccess(req, record.branch);

      if (["settled", "voided"].includes(record.status)) {
        throw badRequest(`This credit is already ${record.status}`);
      }

      const balance = round2(record.amount - record.amountPaid);
      const pay = round2(amount);
      if (!(pay > 0)) throw badRequest("Enter a valid amount");
      if (pay > balance + 0.001) throw badRequest(`Amount exceeds the balance of KES ${balance}`);

      receipt = await Receipt.findById(record.receipt).session(session);
      if (!receipt || receipt.status !== "credit") throw badRequest("This bill is no longer on credit");

      const paidAt = new Date();

      // The money enters the ledger the day it is collected, as a normal
      // cash/till entry. The sale itself was already counted on the day
      // the credit was given, so this is "money collected", not a new sale.
      receipt.payments.push({
        amount: pay,
        method,
        reference: reference || `Credit settlement — ${record.customerName}`,
        paidBy: req.user?._id || null,
        paidAt,
      });
      // Money received only — the "credit" entry is not money.
      receipt.amountPaid = round2(
        receipt.payments.filter(isMoneyEntry).reduce((s, p) => s + p.amount, 0)
      );
      if (method === "cash") receipt.cashAmount = round2((receipt.cashAmount || 0) + pay);
      else receipt.tillAmount = round2((receipt.tillAmount || 0) + pay);

      record.settlements.push({
        amount: pay,
        method,
        reference: reference || null,
        receivedBy: req.user?._id || null,
        receivedByName: req.user?.fullName || null,
        paidAt,
      });
      record.amountPaid = round2(record.amountPaid + pay);

      fullyPaid = record.amountPaid >= record.amount - 0.005;
      if (fullyPaid) {
        record.status = "settled";
        record.settledAt = paidAt;

        // The bill is now fully paid. receipt.paidAt is NOT touched: it stays
        // on the day the credit was given, so the sale keeps its original date.
        receipt.status = "paid";
        const methods = [...new Set(receipt.payments.filter(isMoneyEntry).map((p) => p.method))];
        receipt.paymentMethod = methods.length === 1 ? methods[0] : "both";
        receipt.changeGiven = 0;
      } else {
        record.status = "partial";
      }

      await creditCashback(receipt, pay, { session });
      await receipt.save({ session });
      await record.save({ session });
    });
  } catch (error) {
    if (session) await session.endSession();
    return next(error);
  }
  await session.endSession();

  const io = req.app.get("io");
  io?.emit("receipt:updated", receipt);
  if (fullyPaid) io?.emit("receipt:paid", receipt);
  io?.emit("credit:updated", record);

  logSuccess("credit", "Credit settlement recorded", { billId: record.billId, fullyPaid });
  res.json({
    message: fullyPaid ? "Credit fully settled" : "Part-payment recorded",
    credit: record,
  });
};
