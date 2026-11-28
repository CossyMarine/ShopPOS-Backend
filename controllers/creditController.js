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

// Same customer = same name ignoring case and outer spaces.
const nameKey = (s) => String(s || "").trim().toLowerCase();
const nameExpr = (key) => ({
  $expr: { $eq: [{ $toLower: { $trim: { input: "$customerName" } } }, key] },
});

// If this cashier already has a customer with that name (any case), reuse the
// stored spelling so every bill lands under one name.
const canonicalName = async (userId, typed) => {
  const prior = await CreditRecord.findOne({ createdBy: userId, ...nameExpr(nameKey(typed)) })
    .sort({ createdAt: -1 })
    .select("customerName");
  return prior?.customerName || typed;
};

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

// ------------------------------------------------------------
// Shared: apply one or more payment chunks to a credit record + its receipt.
// chunks = [{ method, amount, reference }]. Returns true if now fully paid.
// The money enters the ledger the day it is collected; the sale itself was
// counted on the day the credit was given, and receipt.paidAt is not touched.
//
// shiftId = the shift that is open right now (the one whose drawer receives
// the money). It is stamped on each settlement so shift reports count the cash
// in the shift that collected it, not in the shift that gave the credit.
// ------------------------------------------------------------
const applySettlement = async ({ record, receipt, chunks, user, shiftId, session }) => {
  const paidAt = new Date();
  let total = 0;

  for (const c of chunks) {
    const pay = round2(c.amount);
    total = round2(total + pay);

    receipt.payments.push({
      amount: pay,
      method: c.method,
      reference: c.reference || `Credit settlement — ${record.customerName}`,
      paidBy: user?._id || null,
      paidAt,
    });
    if (c.method === "cash") receipt.cashAmount = round2((receipt.cashAmount || 0) + pay);
    else receipt.tillAmount = round2((receipt.tillAmount || 0) + pay);

    record.settlements.push({
      amount: pay,
      method: c.method,
      reference: c.reference || null,
      receivedBy: user?._id || null,
      receivedByName: user?.fullName || null,
      shift: shiftId || null,
      paidAt,
    });
  }

  receipt.amountPaid = round2(
    receipt.payments.filter(isMoneyEntry).reduce((s, p) => s + p.amount, 0)
  );
  record.amountPaid = round2(record.amountPaid + total);

  const fullyPaid = record.amountPaid >= record.amount - 0.005;
  if (fullyPaid) {
    record.status = "settled";
    record.settledAt = paidAt;
    receipt.status = "paid";
    const methods = [...new Set(receipt.payments.filter(isMoneyEntry).map((p) => p.method))];
    receipt.paymentMethod = methods.length === 1 ? methods[0] : "both";
    receipt.changeGiven = 0;
  } else {
    record.status = "partial";
  }

  await creditCashback(receipt, total, { session });
  await receipt.save({ session });
  await record.save({ session });
  return fullyPaid;
};

// Take up to `need` from the front of the payment pool, method by method.
const takeFromPool = (pool, need) => {
  const chunks = [];
  let left = round2(need);
  while (left > 0.004 && pool.length) {
    const p = pool[0];
    const take = round2(Math.min(p.amount, left));
    chunks.push({ method: p.method, amount: take, reference: p.reference });
    p.amount = round2(p.amount - take);
    left = round2(left - take);
    if (p.amount <= 0.004) pool.shift();
  }
  return chunks;
};

// ============================================================
// CASHIER: put a bill on credit
// @route PATCH /api/receipts/:id/pay/credit
// ============================================================
export const payOnCredit = async (req, res, next) => {
  const { id } = req.params;
  const { customerName, customerPhone, dueDate } = req.body;
  let session, receipt, record;

  try {
    logStart("credit", "Putting bill on credit", { receiptId: id });
    const typed = String(customerName || "").trim();
    if (!typed) return res.status(400).json({ message: "Customer name is required for credit" });
    const name = await canonicalName(req.user?._id, typed);
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
      receipt.creditCustomerName = name;
      receipt.creditCustomerPhone = String(customerPhone || "").trim() || null;
      receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;

      // The sale: a "credit" payment entry for the full bill, dated today so
      // revenue/profit/items land on the day the goods left. amountPaid is
      // left alone — no money has been received yet.
      receipt.payments.push({
        amount: receipt.totalDue,
        method: "credit",
        reference: `Credit — ${name}`,
        paidBy: req.user?._id || null,
        paidAt: givenAt,
      });
      receipt.paidAt = givenAt;

      await receipt.save({ session });
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
// CASHIER: customers this cashier has given credit to
// @route GET /api/credits/mine/customers?q=&outstanding=true&limit=
//   - name picker:  ?q=jo            (everyone they've served, owing or not)
//   - credit list:  ?outstanding=true (only customers who still owe)
// ============================================================
export const getMyCustomers = async (req, res, next) => {
  try {
    const { q, outstanding } = req.query;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

    const match = { createdBy: req.user._id, status: { $ne: "voided" } };
    if (outstanding === "true") match.status = { $in: ["open", "partial"] };
    if (q && q.trim()) match.customerName = new RegExp(escapeRegex(q.trim()), "i");

    const isOpen = { $in: ["$status", ["open", "partial"]] };
    const rows = await CreditRecord.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { $toLower: { $trim: { input: "$customerName" } } },
          name: { $first: "$customerName" },
          phone: { $first: "$customerPhone" },
          owing: { $sum: { $cond: [isOpen, { $subtract: ["$amount", "$amountPaid"] }, 0] } },
          billCount: { $sum: { $cond: [isOpen, 1, 0] } },
          lastAt: { $max: "$createdAt" },
        },
      },
      { $sort: { lastAt: -1 } },
      { $limit: limit },
    ]);

    res.json({
      customers: rows.map((r) => ({
        name: r.name,
        phone: r.phone || null,
        owing: round2(r.owing),
        billCount: r.billCount,
        lastAt: r.lastAt,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// CASHIER: one customer's outstanding credit bills (oldest first)
// @route GET /api/credits/mine?name=
// ============================================================
export const getMyCredits = async (req, res, next) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ message: "Customer name is required" });

    const credits = await CreditRecord.find({
      createdBy: req.user._id,
      status: { $in: ["open", "partial"] },
      ...nameExpr(nameKey(name)),
    })
      .sort({ createdAt: 1 })
      .populate("receipt", "billId items subtotal createdAt");

    res.json({ credits });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// CASHIER: pay one credit bill, or all of a customer's bills
// @route POST /api/credits/mine/settle
//   { creditId | customerName, payments: [{ method, amount, reference }] }
// Partial payments are fine. Money is spread over the bills oldest-first, so
// a part-payment on "pay all" clears the oldest bills first.
// The route requires an open shift (req.shift): the money is counted in that
// shift's drawer.
// ============================================================
export const settleMine = async (req, res, next) => {
  const { creditId, customerName, payments } = req.body;
  let session, settled = [], clearedCount = 0, remaining = 0;

  try {
    logStart("credit", "Cashier credit settlement", { creditId, customerName });

    const filter = { createdBy: req.user._id, status: { $in: ["open", "partial"] } };
    if (creditId) filter._id = creditId;
    else Object.assign(filter, nameExpr(nameKey(customerName)));

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      settled = [];
      clearedCount = 0;

      const records = await CreditRecord.find(filter).sort({ createdAt: 1 }).session(session);
      if (!records.length) throw notFound("Credit record");

      const owing = round2(records.reduce((s, r) => s + (r.amount - r.amountPaid), 0));
      const paying = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
      if (!(paying > 0)) throw badRequest("Enter a valid amount");
      if (paying > owing + 0.001) throw badRequest(`Amount exceeds the balance of KES ${owing}`);

      const pool = payments.map((p) => ({
        method: p.method,
        amount: round2(p.amount),
        reference: p.reference || null,
      }));

      for (const record of records) {
        if (!pool.length) break;
        const receipt = await Receipt.findById(record.receipt).session(session);
        if (!receipt || receipt.status !== "credit") throw badRequest(`${record.billId} is no longer on credit`);

        const chunks = takeFromPool(pool, record.amount - record.amountPaid);
        if (!chunks.length) break;

        const fullyPaid = await applySettlement({
          record,
          receipt,
          chunks,
          user: req.user,
          shiftId: req.shift?._id || null,
          session,
        });
        if (fullyPaid) clearedCount += 1;
        settled.push({ record, receipt, fullyPaid });
      }
      remaining = round2(owing - paying);
    });
  } catch (error) {
    if (session) await session.endSession();
    return next(error);
  }
  await session.endSession();

  const io = req.app.get("io");
  for (const s of settled) {
    io?.emit("receipt:updated", s.receipt);
    if (s.fullyPaid) io?.emit("receipt:paid", s.receipt);
    io?.emit("credit:updated", s.record);
  }

  logSuccess("credit", "Cashier credit settlement recorded", { bills: settled.length, clearedCount });
  res.json({
    message: remaining <= 0.005 ? "Credit fully cleared" : "Part-payment recorded",
    clearedCount,
    billsTouched: settled.length,
    remaining,
  });
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
// ADMIN: record a settlement (full or part payment) on one record
// @route POST /api/credits/:id/settle   { amount, method, reference }
// If the person recording it has a shift open (req.shift), the money is
// counted in that shift; otherwise it is left unstamped.
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

      fullyPaid = await applySettlement({
        record,
        receipt,
        chunks: [{ method, amount: pay, reference }],
        user: req.user,
        shiftId: req.shift?._id || null,
        session,
      });
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
// ============================================================
// ADMIN: customers who owe, grouped by branch + name
// @route GET /api/credits/customers?branch=
// ============================================================
export const getCreditCustomers = async (req, res, next) => {
  try {
    const match = { status: { $in: ["open", "partial"] } };
    if (req.query.branch) match.branch = new mongoose.Types.ObjectId(req.query.branch);

    const now = new Date();
    const owing = { $subtract: ["$amount", "$amountPaid"] };
    const late = { $and: [{ $ne: ["$dueDate", null] }, { $lt: ["$dueDate", now] }] };

    const rows = await CreditRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: { branch: "$branch", key: { $toLower: { $trim: { input: "$customerName" } } } },
          name: { $first: "$customerName" },
          phone: { $max: "$customerPhone" }, // $max skips nulls
          owing: { $sum: owing },
          billCount: { $sum: 1 },
          overdueAmount: { $sum: { $cond: [late, owing, 0] } },
          overdueCount: { $sum: { $cond: [late, 1, 0] } },
          oldestBillAt: { $min: "$createdAt" },
          nextDue: { $min: "$dueDate" },
        },
      },
      { $lookup: { from: "branches", localField: "_id.branch", foreignField: "_id", as: "b" } },
      { $sort: { owing: -1 } },
      { $limit: 300 },
    ]);

    res.json({
      customers: rows.map((r) => ({
        name: r.name,
        phone: r.phone || null,
        branchId: r._id.branch,
        branchName: r.b?.[0]?.name || "—",
        owing: round2(r.owing),
        billCount: r.billCount,
        overdueAmount: round2(r.overdueAmount),
        overdueCount: r.overdueCount,
        oldestBillAt: r.oldestBillAt,
        nextDue: r.nextDue,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// ADMIN: one customer's open bills (oldest first)
// @route GET /api/credits/customer?name=&branch=
// ============================================================
export const getCreditCustomer = async (req, res, next) => {
  try {
    const name = String(req.query.name || "").trim();
    const { branch } = req.query;
    if (!name || !branch) return res.status(400).json({ message: "Customer name and branch are required" });
    assertBranchAccess(req, branch);

    const credits = await CreditRecord.find({
      branch,
      status: { $in: ["open", "partial"] },
      ...nameExpr(nameKey(name)),
    })
      .sort({ createdAt: 1 })
      .populate("receipt", "billId items subtotal createdAt");

    res.json({ credits });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// ADMIN: pay one bill, or all of a customer's bills (oldest first)
// @route POST /api/credits/customer/settle
//   { branch, customerName, creditId?, payments: [{ method, amount, reference }] }
// ============================================================
export const settleCreditCustomer = async (req, res, next) => {
  const { branch, creditId, customerName, payments } = req.body;
  let session, settled = [], clearedCount = 0, remaining = 0;

  try {
    logStart("credit", "Admin credit settlement", { creditId, customerName });
    assertBranchAccess(req, branch);

    const filter = { branch, status: { $in: ["open", "partial"] }, ...nameExpr(nameKey(customerName)) };
    if (creditId) filter._id = creditId;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      settled = [];
      clearedCount = 0;

      const records = await CreditRecord.find(filter).sort({ createdAt: 1 }).session(session);
      if (!records.length) throw notFound("Credit record");

      const owing = round2(records.reduce((s, r) => s + (r.amount - r.amountPaid), 0));
      const paying = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
      if (!(paying > 0)) throw badRequest("Enter a valid amount");
      if (paying > owing + 0.001) throw badRequest(`Amount exceeds the balance of KES ${owing}`);

      const pool = payments.map((p) => ({
        method: p.method,
        amount: round2(p.amount),
        reference: p.reference || null,
      }));

      for (const record of records) {
        if (!pool.length) break;
        const receipt = await Receipt.findById(record.receipt).session(session);
        if (!receipt || receipt.status !== "credit") throw badRequest(`${record.billId} is no longer on credit`);

        const chunks = takeFromPool(pool, record.amount - record.amountPaid);
        if (!chunks.length) break;

        const fullyPaid = await applySettlement({
          record, receipt, chunks, user: req.user,
          shiftId: req.shift?._id || null, // null for admin with no open shift (same as settleCredit)
          session,
        });
        if (fullyPaid) clearedCount += 1;
        settled.push({ record, receipt, fullyPaid });
      }
      remaining = round2(owing - paying);
    });
  } catch (error) {
    if (session) await session.endSession();
    return next(error);
  }
  await session.endSession();

  const io = req.app.get("io");
  for (const s of settled) {
    io?.emit("receipt:updated", s.receipt);
    if (s.fullyPaid) io?.emit("receipt:paid", s.receipt);
    io?.emit("credit:updated", s.record);
  }

  logSuccess("credit", "Admin credit settlement recorded", { bills: settled.length, clearedCount });
  res.json({
    message: remaining <= 0.005 ? "Credit fully cleared" : "Part-payment recorded",
    clearedCount,
    billsTouched: settled.length,
    remaining,
  });
};
