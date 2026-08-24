// controllers/paymentController.js
// Powers the admin/branch "Payments" page: a flat, filterable/searchable feed of every
// payment ever recorded (cash, till, STK, reward...) plus the queue of
// customer-submitted manual-till payments still waiting for staff confirmation.
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import { applyPaymentToReceipt } from "../utils/walletPayments.js";
import { getDateRangePreset } from "../utils/dateHelpers.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";

// Builds a Mongo range from either a named preset (Kenya/EAT-anchored,
// via utils/dateHelpers.js) or explicit from/to ISO dates from the calendar picker.
const resolveDateRange = ({ preset, from, to }) => {
  if (preset && preset !== "custom") {
    const { startDate, endDate } = getDateRangePreset(preset);
    return { $gte: startDate, $lte: endDate };
  }
  if (from || to) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    return range;
  }
  return null;
};

// @desc    Flattened, paginated list of individual payment entries across all
//          bills — filterable by method/branch, searchable by bill/cashier/reference/payer.
// @route   GET /api/payments/transactions?page=1&limit=15&method=cash&branch=&q=&from=&to=&preset=
// @access  Protected — admin, branchManager (auto-scoped to own branch via sameBranch)
export const getTransactions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 15);
    const { method, q, from, to, preset, branch } = req.query;

    logStart("payment", "Loading transactions", { page, limit, method, q, preset, branch });

    const pipeline = [{ $unwind: "$payments" }];

    const matchStage = {};
    if (method) matchStage["payments.method"] = method;
    if (branch) matchStage["branch"] = new mongoose.Types.ObjectId(branch);
    const dateRange = resolveDateRange({ preset, from, to });
    if (dateRange) matchStage["payments.paidAt"] = dateRange;
    if (Object.keys(matchStage).length) pipeline.push({ $match: matchStage });

    pipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "payments.paidBy",
          foreignField: "_id",
          as: "payerDoc",
        },
      },
      {
        $addFields: {
          payerName: { $ifNull: [{ $arrayElemAt: ["$payerDoc.fullName", 0] }, null] },
        },
      }
    );

    if (q) {
      const trimmed = q.trim();
      const orClauses = [
        { billId: { $regex: trimmed, $options: "i" } },
        { cashierName: { $regex: trimmed, $options: "i" } },
        { "payments.reference": { $regex: trimmed, $options: "i" } },
        { payerName: { $regex: trimmed, $options: "i" } },
      ];
      pipeline.push({ $match: { $or: orClauses } });
    }

    pipeline.push({ $sort: { "payments.paidAt": -1 } });

    const countPipeline = [...pipeline, { $count: "total" }];
    const dataPipeline = [
      ...pipeline,
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          paymentId: "$payments._id",
          receiptId: "$_id",
          billId: 1,
          branch: 1,
          cashierName: 1,
          status: 1,
          amount: "$payments.amount",
          method: "$payments.method",
          reference: "$payments.reference",
          paidAt: "$payments.paidAt",
          payerName: 1,
        },
      },
    ];

    const [transactions, countRes] = await Promise.all([
      Receipt.aggregate(dataPipeline),
      Receipt.aggregate(countPipeline),
    ]);
    const total = countRes[0]?.total || 0;

    logSuccess("payment", "Transactions loaded", { returned: transactions.length, total, page });
    res.json({
      transactions,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    logError("payment", "Error fetching transactions", error);
    res.status(500).json({ message: "Failed to fetch transactions" });
  }
};

// @desc    Summary totals for the Payments dashboard cards — Total Money,
//          Total Cash, Paid using Reward, Till, Prompt — over a date range,
//          optionally scoped to one branch.
//          ?preset=today|this_week|last_7_days|this_month|last_30_days is
//          Kenya/EAT-anchored (see utils/dateHelpers.js); or pass explicit
//          ?from=&to= ISO dates for a custom calendar range.
// @route   GET /api/payments/summary
// @access  Protected — admin, branchManager
export const getPaymentSummary = async (req, res) => {
  try {
    const { from, to, preset, branch } = req.query;
    logStart("payment", "Loading payment summary", { preset, from, to, branch });

    const dateRange = resolveDateRange({ preset, from, to });

    const pipeline = [];
    if (branch) pipeline.push({ $match: { branch: new mongoose.Types.ObjectId(branch) } });
    pipeline.push({ $unwind: "$payments" });
    if (dateRange) pipeline.push({ $match: { "payments.paidAt": dateRange } });

    pipeline.push({
      $group: {
        _id: null,
        totalMoney: { $sum: "$payments.amount" },
        totalCash: {
          $sum: { $cond: [{ $eq: ["$payments.method", "cash"] }, "$payments.amount", 0] },
        },
        totalReward: {
          $sum: { $cond: [{ $eq: ["$payments.method", "reward"] }, "$payments.amount", 0] },
        },
        // Till = anything paid to a business till/paybill number and reconciled
        // manually by staff (Buy Goods, Paybill, Pochi la Biashara, manual entry)
        totalTill: {
          $sum: {
            $cond: [
              { $in: ["$payments.method", ["mpesa_till", "manual_till", "mpesa_pochi", "mpesa_paybill"]] },
              "$payments.amount",
              0,
            ],
          },
        },
        // Prompt = STK push, the automated pay-prompt sent to the customer's phone
        totalPrompt: {
          $sum: { $cond: [{ $eq: ["$payments.method", "mpesa_stk"] }, "$payments.amount", 0] },
        },
      },
    });

    const [result] = await Receipt.aggregate(pipeline);

    const summary = {
      totalMoney: result?.totalMoney || 0,
      totalCash: result?.totalCash || 0,
      totalReward: result?.totalReward || 0,
      totalTill: result?.totalTill || 0,
      totalPrompt: result?.totalPrompt || 0,
    };

    logSuccess("payment", "Payment summary loaded", summary);
    res.json(summary);
  } catch (error) {
    logError("payment", "Error fetching payment summary", error);
    res.status(500).json({ message: "Failed to fetch payment summary" });
  }
};

// @desc    Every customer-submitted manual-till payment still awaiting confirmation,
//          optionally scoped to one branch
// @route   GET /api/payments/pending?branch=
// @access  Protected — admin, branchManager
export const getPendingManualPayments = async (req, res) => {
  try {
    logStart("payment", "Loading pending manual payments", { branch: req.query.branch || "all" });

    const filter = { "pendingManualPayments.0": { $exists: true } };
    if (req.query.branch) filter.branch = req.query.branch;

    const receipts = await Receipt.find(filter)
      .populate("pendingManualPayments.paidBy", "fullName")
      .sort({ updatedAt: -1 });

    const pending = [];
    receipts.forEach((r) => {
      r.pendingManualPayments.forEach((p) => {
        pending.push({
          receiptId: r._id,
          paymentId: p._id,
          billId: r.billId,
          branch: r.branch,
          cashierName: r.cashierName,
          subtotal: r.subtotal,
          amountPaid: r.amountPaid || 0,
          balanceDue: Number((r.totalDue - (r.amountPaid || 0)).toFixed(2)),
          amount: p.amount,
          reference: p.reference,
          paidByName: p.paidBy?.fullName || p.paidByName || "Customer",
          submittedAt: p.submittedAt,
        });
      });
    });
    pending.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    logSuccess("payment", "Pending manual payments loaded", { count: pending.length });
    res.json(pending);
  } catch (error) {
    logError("payment", "Error fetching pending manual payments", error);
    res.status(500).json({ message: "Failed to fetch pending payments" });
  }
};

// @desc    Count of all pending manual-till submissions — powers the sidebar badge
// @route   GET /api/payments/pending/count?branch=
// @access  Protected — admin, branchManager
export const getPendingManualPaymentsCount = async (req, res) => {
  try {
    logStart("payment", "Counting pending manual payments", { branch: req.query.branch || "all" });

    const match = req.query.branch ? [{ $match: { branch: new mongoose.Types.ObjectId(req.query.branch) } }] : [];
    const result = await Receipt.aggregate([
      ...match,
      { $project: { count: { $size: { $ifNull: ["$pendingManualPayments", []] } } } },
      { $group: { _id: null, total: { $sum: "$count" } } },
    ]);

    const count = result[0]?.total || 0;
    logSuccess("payment", "Pending manual payments counted", { count });
    res.json({ count });
  } catch (error) {
    logError("payment", "Error counting pending manual payments", error);
    res.status(500).json({ message: "Failed to count pending payments" });
  }
};

// @desc    Staff confirms a customer-submitted manual till payment — applies
//          it to the bill (may flip status to partial/paid) and credits cashback.
// @route   PATCH /api/payments/pending/:receiptId/:paymentId/confirm
// @access  Protected — admin, branchManager
export const confirmManualPayment = async (req, res) => {
  const { receiptId, paymentId } = req.params;
  try {
    logStart("payment", "Confirming manual payment", { receiptId, paymentId });

    const receipt = await Receipt.findById(receiptId);
    if (!receipt) {
      console.warn(`[payment] ⚠️ Bill not found: ${receiptId}`);
      return res.status(404).json({ message: "Bill not found" });
    }

    const entry = receipt.pendingManualPayments.id(paymentId);
    if (!entry) {
      console.warn(`[payment] ⚠️ Pending payment not found: ${paymentId} on receipt ${receiptId}`);
      return res.status(404).json({ message: "Pending payment not found" });
    }

    const { amount, reference, paidBy } = entry;
    receipt.pendingManualPayments.pull(paymentId);

    const io = req.app.get("io");
    const updated = await applyPaymentToReceipt({
      receipt,
      amount,
      method: "manual_till",
      reference,
      paidBy,
      io,
    });

    io.to(`branch:${updated.branch}`).emit("receipt:manualPaymentResolved", {
      receiptId: updated._id,
      paymentId,
      action: "confirmed",
    });

    logSuccess("payment", "Manual payment confirmed", { receiptId, paymentId, amount, newStatus: updated.status });
    res.json({ message: "Payment confirmed", receipt: updated });
  } catch (error) {
    logError("payment", "Error confirming manual payment", error);
    res.status(500).json({ message: "Failed to confirm payment", error: error.message });
  }
};

// @desc    Staff rejects a customer's claimed manual till payment — discarded,
//          the bill's balance is untouched since it was never applied.
// @route   PATCH /api/payments/pending/:receiptId/:paymentId/reject
// @access  Protected — admin, branchManager
export const rejectManualPayment = async (req, res) => {
  const { receiptId, paymentId } = req.params;
  try {
    logStart("payment", "Rejecting manual payment", { receiptId, paymentId });

    const receipt = await Receipt.findById(receiptId);
    if (!receipt) {
      console.warn(`[payment] ⚠️ Bill not found: ${receiptId}`);
      return res.status(404).json({ message: "Bill not found" });
    }

    const entry = receipt.pendingManualPayments.id(paymentId);
    if (!entry) {
      console.warn(`[payment] ⚠️ Pending payment not found: ${paymentId} on receipt ${receiptId}`);
      return res.status(404).json({ message: "Pending payment not found" });
    }

    receipt.pendingManualPayments.pull(paymentId);
    await receipt.save();

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("receipt:manualPaymentResolved", { receiptId: receipt._id, paymentId, action: "rejected" });
    io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);

    logSuccess("payment", "Manual payment rejected", { receiptId, paymentId });
    res.json({ message: "Payment rejected", receipt });
  } catch (error) {
    logError("payment", "Error rejecting manual payment", error);
    res.status(500).json({ message: "Failed to reject payment", error: error.message });
  }
};
