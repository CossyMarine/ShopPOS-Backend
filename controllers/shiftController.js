// controllers/shiftController.js
import Shift from "../models/Shift.js";
import PettyCash from "../models/PettyCash.js";
import Receipt from "../models/Receipt.js";
import VoidRequest from "../models/VoidRequest.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Open a shift for the logged-in user. No cash float is asked for.
// @route   POST /api/shifts/open
// @access  Protected
export const openShift = async (req, res, next) => {
  const openedBy = req.user._id;

  if (!req.user.branch) {
    return res.status(400).json({ message: "Your account has no assigned branch" });
  }

  try {
    logStart("shift", "Opening shift", { openedBy });

    const existing = await Shift.findOne({ openedBy, status: "open" });
    if (existing) {
      console.warn(`[shift] ⚠️ Shift already open for user ${openedBy}`);
      return res.status(400).json({ message: "You already have a shift open", shift: existing });
    }

    const shift = await Shift.create({ openedBy, branch: req.user.branch });

    const io = req.app.get("io");
    io.to(`branch:${shift.branch}`).emit("shift:opened", shift);

    logSuccess("shift", "Shift opened", { shiftId: shift._id, openedBy });
    res.status(201).json(shift);
  } catch (error) {
    next(error);
  }
};

// @desc    Get the logged-in user's own open shift, or null
// @route   GET /api/shifts/current
// @access  Protected
export const getCurrentShift = async (req, res, next) => {
  try {
    logStart("shift", "Fetching current shift", { user: req.user._id });
    const shift = await Shift.findOne({ openedBy: req.user._id, status: "open" }).populate("openedBy", "fullName");
    logSuccess("shift", "Current shift fetched", { found: Boolean(shift), shiftId: shift?._id });
    res.json(shift);
  } catch (error) {
    next(error);
  }
};

// @desc    Log a petty cash out-payment against an open shift
// @route   POST /api/shifts/:id/petty-cash
// @access  Protected
export const addPettyCash = async (req, res, next) => {
  const { id } = req.params;
  const { amount, reason } = req.body;
  const loggedBy = req.user._id;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: "amount must be a positive number" });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ message: "reason is required" });
  }

  try {
    logStart("shift", "Adding petty cash entry", { shiftId: id, amount, loggedBy });

    const shift = await Shift.findById(id);
    if (!shift) {
      console.warn(`[shift] ⚠️ Shift not found: ${id}`);
      return res.status(404).json({ message: "Shift not found" });
    }
    if (!req.user.isAdmin && req.user.role !== "cashier" && String(shift.openedBy) !== String(req.user._id)) {
      console.warn(`[shift] ⚠️ Ownership mismatch on shift ${id}`);
      return res.status(403).json({ message: "This isn't your shift" });
    }
    if (shift.status !== "open") {
      console.warn(`[shift] ⚠️ Cannot log petty cash — shift ${id} is ${shift.status}`);
      return res.status(400).json({ message: "Cannot log petty cash against a closed shift" });
    }

    const entry = await PettyCash.create({ shift: id, amount, reason: reason.trim(), loggedBy });

    const io = req.app.get("io");
    io.to(`branch:${shift.branch}`).emit("shift:pettyCashAdded", entry);

    logSuccess("shift", "Petty cash entry added", { shiftId: id, entryId: entry._id, amount });
    res.status(201).json(entry);
  } catch (error) {
    next(error);
  }
};

// Shared calculation used by preview + real close.
const computeShiftSummary = async (shiftId) => {
  const shift = await Shift.findById(shiftId).populate("openedBy", "fullName").populate("closedBy", "fullName");
  if (!shift) return null;

  const receipts = await Receipt.find({ shift: shiftId, status: { $in: ["paid", "partial"] } });

  const totals = { cash: 0, till: 0, prompt: 0, reward: 0 };
  receipts.forEach((r) => {
    r.payments.forEach((p) => {
      if (p.method === "cash") totals.cash += p.amount;
      else if (["mpesa_till", "manual_till", "mpesa_paybill", "mpesa_pochi"].includes(p.method)) totals.till += p.amount;
      else if (p.method === "mpesa_stk") totals.prompt += p.amount;
      else if (p.method === "reward") totals.reward += p.amount;
    });
  });

  const voidedReceipts = await Receipt.find({ shift: shiftId, status: "voided" });
  const voidedTotal = voidedReceipts.reduce((sum, r) => sum + r.subtotal, 0);
  const voidCount = voidedReceipts.length;

  const pettyEntries = await PettyCash.find({ shift: shiftId });
  const pettyCashOut = pettyEntries.reduce((sum, e) => sum + e.amount, 0);

  const shiftReceiptIds = await Receipt.find({ shift: shiftId }).distinct("_id");
  const pendingVoidRequests = await VoidRequest.countDocuments({
    status: "pending",
    receipt: { $in: shiftReceiptIds },
  });

  const ordersCount = await Order.countDocuments({
    cashier: shift.openedBy._id,
    createdAt: { $gte: shift.createdAt, ...(shift.closedAt ? { $lte: shift.closedAt } : {}) },
  });

  // openingFloat is 0 now that the open-shift prompt is gone
  const expectedCash = (shift.openingFloat || 0) + totals.cash - pettyCashOut;
  const grandTotal = totals.cash + totals.till + totals.prompt + totals.reward;
  const variance = shift.closingCashCount !== null ? shift.closingCashCount - expectedCash : null;

  return {
    shiftId: shift._id,
    status: shift.status,
    branch: shift.branch,
    openedBy: shift.openedBy,
    openedAt: shift.createdAt,
    closedBy: shift.closedBy,
    closedAt: shift.closedAt,
    openingFloat: shift.openingFloat,
    cashSales: totals.cash,
    tillSales: totals.till,
    promptSales: totals.prompt,
    rewardSales: totals.reward,
    voidedTotal,
    voidCount,
    ordersCount,
    pettyCashOut,
    expectedCash,
    grandTotal,
    closingCashCount: shift.closingCashCount,
    variance,
    pendingVoidRequests,
  };
};

// @desc    Preview a shift's totals without closing it
// @route   GET /api/shifts/:id/summary
// @access  Protected
export const getShiftSummary = async (req, res, next) => {
  const { id } = req.params;
  try {
    logStart("shift", "Computing shift summary", { shiftId: id });

    const shift = await Shift.findById(id);
    if (!shift) {
      console.warn(`[shift] ⚠️ Shift not found: ${id}`);
      return res.status(404).json({ message: "Shift not found" });
    }
    if (!req.user.isAdmin && req.user.role !== "cashier" && String(shift.openedBy) !== String(req.user._id)) {
      console.warn(`[shift] ⚠️ Ownership mismatch on shift ${id}`);
      return res.status(403).json({ message: "This isn't your shift" });
    }
    const summary = await computeShiftSummary(id);
    logSuccess("shift", "Shift summary computed", { shiftId: id, grandTotal: summary.grandTotal });
    res.json(summary);
  } catch (error) {
    next(error);
  }
};

// @desc    Close a shift (counted cash still required)
// @route   POST /api/shifts/:id/close
// @access  Protected
export const closeShift = async (req, res, next) => {
  const { id } = req.params;
  const { closingCashCount, notes } = req.body;
  const closedBy = req.user._id;

  if (closingCashCount === undefined || closingCashCount === null || isNaN(closingCashCount)) {
    return res.status(400).json({ message: "closingCashCount is required and must be a number" });
  }

  try {
    logStart("shift", "Closing shift", { shiftId: id, closingCashCount, closedBy });

    const shift = await Shift.findById(id);
    if (!shift) {
      console.warn(`[shift] ⚠️ Shift not found: ${id}`);
      return res.status(404).json({ message: "Shift not found" });
    }
    if (!req.user.isAdmin && req.user.role !== "cashier" && String(shift.openedBy) !== String(req.user._id)) {
      console.warn(`[shift] ⚠️ Ownership mismatch on shift ${id}`);
      return res.status(403).json({ message: "This isn't your shift" });
    }
    if (shift.status !== "open") {
      console.warn(`[shift] ⚠️ Shift ${id} already closed`);
      return res.status(400).json({ message: "Shift is already closed" });
    }

    shift.closingCashCount = closingCashCount;
    shift.notes = notes || null;
    shift.closedBy = closedBy;
    shift.closedAt = new Date();
    shift.status = "closed";
    await shift.save();

    const summary = await computeShiftSummary(id);

    const io = req.app.get("io");
    io.to(`branch:${shift.branch}`).emit("shift:closed", summary);

    logSuccess("shift", "Shift closed", { shiftId: id, variance: summary.variance });
    res.json(summary);
  } catch (error) {
    next(error);
  }
};

// @desc    Admin/branchManager — shift history for one cashier, filterable by date
// @route   GET /api/shifts/history/:userId?from=&to=
// @access  Protected — admin, branchManager
export const getShiftHistory = async (req, res, next) => {
  const { userId } = req.params;
  const { from, to } = req.query;
  try {
    logStart("shift", "Loading shift history", { userId, from, to });

    const query = { openedBy: userId };
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    const shifts = await Shift.find(query).sort({ createdAt: -1 }).populate("closedBy", "fullName");

    logSuccess("shift", "Shift history loaded", { userId, count: shifts.length });
    res.json(shifts);
  } catch (error) {
    next(error);
  }
};

// @desc    Open a shift on behalf of a specific named cashier (shared register login)
// @route   POST /api/shifts/cashier/:cashierId/open
// @access  Protected — cashier (station), branchManager, or admin
export const openShiftForCashier = async (req, res, next) => {
  const { cashierId } = req.params;

  try {
    logStart("shift", "Opening shift for cashier", { cashierId });

    const cashier = await User.findOne({ _id: cashierId, role: "cashier" });
    if (!cashier) {
      console.warn(`[shift] ⚠️ Cashier not found: ${cashierId}`);
      return res.status(404).json({ message: "Cashier not found" });
    }
    if (!cashier.branch) {
      console.warn(`[shift] ⚠️ Cashier ${cashierId} has no assigned branch`);
      return res.status(400).json({ message: "This cashier has no assigned branch" });
    }

    const existing = await Shift.findOne({ openedBy: cashierId, status: "open" });
    if (existing) {
      console.warn(`[shift] ⚠️ ${cashier.fullName} already has a shift open`);
      return res.status(400).json({ message: `${cashier.fullName} already has a shift open`, shift: existing });
    }

    const shift = await Shift.create({ openedBy: cashierId, branch: cashier.branch });

    const io = req.app.get("io");
    io.to(`branch:${shift.branch}`).emit("shift:opened", shift);

    logSuccess("shift", "Cashier shift opened", { shiftId: shift._id, cashierId });
    res.status(201).json(shift);
  } catch (error) {
    next(error);
  }
};

// @desc    Current open-shift status for a specific named cashier
// @route   GET /api/shifts/cashier/:cashierId/status
// @access  Protected — cashier (station), branchManager, or admin
export const getShiftStatusForCashier = async (req, res, next) => {
  const { cashierId } = req.params;
  try {
    logStart("shift", "Fetching cashier shift status", { cashierId });
    const shift = await Shift.findOne({ openedBy: cashierId, status: "open" });
    logSuccess("shift", "Cashier shift status fetched", { cashierId, found: Boolean(shift) });
    res.json(shift);
  } catch (error) {
    next(error);
  }
};

// @desc    Admin/branchManager — all shifts with per-method totals and cash result
// @route   GET /api/shifts?branch=&cashier=&from=&to=&page=&limit=
// @access  Protected — admin, branchManager (branch-scoped via sameBranch)
export const getShiftsReport = async (req, res, next) => {
  const { branch, cashier, from, to } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 15));

  try {
    const query = {};
    if (branch) query.branch = branch;
    if (cashier) query.openedBy = cashier;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }

    const [total, shifts] = await Promise.all([
      Shift.countDocuments(query),
      Shift.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("openedBy", "fullName")
        .populate("closedBy", "fullName")
        .populate("branch", "name"),
    ]);

    const ids = shifts.map((s) => s._id);
    const [receipts, petty] = await Promise.all([
      Receipt.find({ shift: { $in: ids }, status: { $in: ["paid", "partial"] } }).select("shift payments"),
      PettyCash.find({ shift: { $in: ids } }).select("shift amount"),
    ]);

    const totalsByShift = new Map();
    const get = (id) => {
      const k = String(id);
      if (!totalsByShift.has(k)) totalsByShift.set(k, { cash: 0, till: 0, mpesa: 0, reward: 0, petty: 0 });
      return totalsByShift.get(k);
    };

    receipts.forEach((r) => {
      const t = get(r.shift);
      r.payments.forEach((p) => {
        if (p.method === "cash") t.cash += p.amount;
        else if (["mpesa_till", "manual_till", "mpesa_paybill", "mpesa_pochi"].includes(p.method)) t.till += p.amount;
        else if (p.method === "mpesa_stk") t.mpesa += p.amount;
        else if (p.method === "reward") t.reward += p.amount;
      });
    });
    petty.forEach((e) => { get(e.shift).petty += e.amount; });

    const rows = shifts.map((s) => {
      const t = get(s._id);
      const expectedCash = (s.openingFloat || 0) + t.cash - t.petty;
      let difference = null;
      let result = "open";
      if (s.status === "closed" && s.closingCashCount !== null) {
        difference = Number((s.closingCashCount - expectedCash).toFixed(2));
        result = difference < 0 ? "negative" : difference > 0 ? "extra" : "exact";
      }
      return {
        _id: s._id,
        cashier: s.openedBy?.fullName || "—",
        branch: s.branch?.name || "",
        status: s.status,
        openedAt: s.createdAt,
        closedAt: s.closedAt,
        totalSales: t.cash + t.till + t.mpesa + t.reward,
        cash: t.cash,
        till: t.till,
        mpesa: t.mpesa,
        reward: t.reward,
        pettyCashOut: t.petty,
        expectedCash,
        cashCounted: s.closingCashCount,
        difference,
        result, // "negative" | "exact" | "extra" | "open"
      };
    });

    res.json({ shifts: rows, page, totalPages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (error) {
    next(error);
  }
};
