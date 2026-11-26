// controllers/analyticsOpsController.js
// Losses, petty cash, day report, till check, staff accountability and audit
// trail for the Admin Analytics page. Every figure comes from records that
// already exist: StockAdjustment, PettyCash, VoidRequest, Shift and Receipt.
//
// A "sale" is a receipt that is paid OR given on credit, dated by
// receipt.paidAt (for credit bills: the day the credit was given).
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import StockAdjustment from "../models/StockAdjustment.js";
import VoidRequest from "../models/VoidRequest.js";
import PettyCash from "../models/PettyCash.js";
import Shift from "../models/Shift.js";
import AdminSettings from "../models/AdminSettings.js";
import { resolveAnalyticsRange, costEstimationStages } from "./analyticsController.js";
import { loadShiftTotals } from "./shiftController.js";
import { salesStages } from "../utils/vatReport.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";
import { badRequest } from "../utils/AppError.js";

const { ObjectId } = mongoose.Types;
const TZ = "Africa/Nairobi";

// Receipt statuses that count as a sale.
const SOLD = ["paid", "credit"];

const dayStr = (f) => ({ $dateToString: { format: "%Y-%m-%d", date: f, timezone: TZ } });
const dayKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
const kes = (n) => `KES ${Math.round(n || 0).toLocaleString("en-KE")}`;
const r0 = (n) => Math.round(n || 0);
const sumBy = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const nice = (s) => String(s || "").replace(/_/g, " ");

const scope = (q) => {
  const { range = "today", from, to, branch } = q;
  const { start, end } = resolveAnalyticsRange(range, from, to);
  return { start, end, branch, branchMatch: branch ? { branch: new ObjectId(branch) } : {} };
};

// A line sold for less than it cost (needs the real FIFO cost captured at sale)
const BELOW = {
  "items.costPriceAtSale": { $ne: null },
  $expr: { $lt: ["$items.unitPrice", "$items.costPriceAtSale"] },
};

const lossesByDay = (match) =>
  StockAdjustment.aggregate([
    { $match: { status: "approved", ...match } },
    {
      $group: {
        _id: { day: dayStr("$reviewedAt"), reason: "$reason" },
        cost: { $sum: { $ifNull: ["$costImpact", 0] } },
        count: { $sum: 1 },
      },
    },
  ]);

const pettyByDay = (start, end, branch) =>
  PettyCash.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $lookup: { from: "shifts", localField: "shift", foreignField: "_id", as: "sh" } },
    { $unwind: "$sh" },
    ...(branch ? [{ $match: { "sh.branch": new ObjectId(branch) } }] : []),
    { $group: { _id: dayStr("$createdAt"), amount: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);

const belowCostByDay = (match) =>
  Receipt.aggregate([
    { $match: { status: { $in: SOLD }, ...match } },
    { $unwind: "$items" },
    { $match: BELOW },
    {
      $group: {
        _id: dayStr("$paidAt"),
        loss: { $sum: { $multiply: [{ $subtract: ["$items.costPriceAtSale", "$items.unitPrice"] }, "$items.quantity"] } },
        lines: { $sum: 1 },
      },
    },
  ]);

// Closed shifts: expected cash = opening float + cash sales - petty cash (same
// formula the shift close screen uses), compared with what the cashier counted.
//
// The cash figure comes from loadShiftTotals in shiftController, so this report
// and the shift screens can never disagree. Credit settlements are counted in
// the shift that collected the money (see shiftController).
const loadTillRows = async (branch, start, end) => {
  const shifts = await Shift.find({
    status: "closed",
    closingCashCount: { $ne: null },
    closedAt: { $gte: start, $lte: end },
    ...(branch ? { branch: new ObjectId(branch) } : {}),
  })
    .populate("openedBy", "fullName")
    .sort({ closedAt: -1 })
    .limit(60)
    .lean();
  if (!shifts.length) return [];
  const ids = shifts.map((s) => s._id);
  const [totalsOf, petty] = await Promise.all([
    loadShiftTotals(shifts),
    PettyCash.find({ shift: { $in: ids } }).select("shift amount").lean(),
  ]);
  const out = {};
  petty.forEach((e) => { out[e.shift] = (out[e.shift] || 0) + e.amount; });
  return shifts.map((s) => {
    const expected = (s.openingFloat || 0) + totalsOf(s._id).cash - (out[s._id] || 0);
    return {
      shiftId: s._id,
      date: dayKey(s.closedAt),
      closedAt: s.closedAt,
      cashier: s.openedBy?.fullName || "Unknown",
      expected: r0(expected),
      counted: r0(s.closingCashCount),
      difference: Math.round((s.closingCashCount - expected) * 100) / 100,
    };
  });
};

// GET /api/analytics/costs  ->  approved stock losses, petty cash, below-cost sales
export const getCosts = async (req, res, next) => {
  try {
    const { start, end, branch, branchMatch } = scope(req.query);
    logStart("analytics", "Loading losses and petty cash", { branch: branch || "all" });
    const [losses, petty, below, pending] = await Promise.all([
      lossesByDay({ reviewedAt: { $gte: start, $lte: end }, ...branchMatch }),
      pettyByDay(start, end, branch),
      belowCostByDay({ paidAt: { $gte: start, $lte: end }, ...branchMatch }),
      StockAdjustment.countDocuments({ status: "pending", ...branchMatch }),
    ]);

    const daily = {};
    const byReason = {};
    const day = (d) => (daily[d] ||= { date: d, stockLoss: 0, pettyCash: 0 });
    losses.forEach((l) => {
      day(l._id.day).stockLoss += l.cost;
      const o = (byReason[l._id.reason] ||= { reason: l._id.reason, cost: 0, count: 0 });
      o.cost += l.cost;
      o.count += l.count;
    });
    petty.forEach((p) => { day(p._id).pettyCash += p.amount; });

    res.json({
      totals: {
        stockLoss: r0(sumBy(losses, (l) => l.cost)),
        pettyCash: r0(sumBy(petty, (p) => p.amount)),
        belowCostLoss: r0(sumBy(below, (b) => b.loss)),
        belowCostLines: sumBy(below, (b) => b.lines),
        pendingLossReports: pending,
      },
      byReason: Object.values(byReason).map((o) => ({ ...o, cost: r0(o.cost) })),
      daily: Object.values(daily)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((d) => ({ date: d.date, stockLoss: r0(d.stockLoss), pettyCash: r0(d.pettyCash) })),
    });
    logSuccess("analytics", "Losses and petty cash loaded");
  } catch (error) {
    next(error);
  }
};

// GET /api/analytics/day?date=YYYY-MM-DD&branch=
// Why was this day better or worse than usual? Compared with the average of
// the 30 days before it. Salaries are left out: payslips are paid monthly, so
// they cannot be pinned to a single day.
export const getDayReport = async (req, res, next) => {
  try {
    const { date, branch } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw badRequest("date must be YYYY-MM-DD");
    const vatCfg = (await AdminSettings.getSettings()).vat || {};
    const sales = salesStages(!!vatCfg.enabled, vatCfg.rate);

    const dayStart = new Date(`${date}T00:00:00.000+03:00`);
    const dayEnd = new Date(`${date}T23:59:59.999+03:00`);
    const baseStart = new Date(dayStart.getTime() - 30 * 864e5);
    const branchMatch = branch ? { branch: new ObjectId(branch) } : {};
    const inDay = { $gte: dayStart, $lte: dayEnd };
    logStart("analytics", "Loading day report", { date, branch: branch || "all" });

    const [salesRows, lossRows, pettyRows, adjustments, voids, belowLines, creditRows] = await Promise.all([
      Receipt.aggregate([
        { $match: { status: { $in: SOLD }, paidAt: { $gte: baseStart, $lte: dayEnd }, ...branchMatch } },
        { $unwind: "$items" },
        { $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "product" } },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        ...costEstimationStages(),
        ...sales,
        { $group: { _id: dayStr("$paidAt"), net: { $sum: "$lineNet" }, cost: { $sum: "$lineCost" } } },
      ]),
      lossesByDay({ reviewedAt: { $gte: baseStart, $lte: dayEnd }, ...branchMatch }),
      pettyByDay(baseStart, dayEnd, branch),
      StockAdjustment.find({ createdAt: inDay, ...branchMatch })
        .populate("product", "name").populate("requestedBy", "fullName").populate("reviewedBy", "fullName")
        .sort({ createdAt: 1 }).lean(),
      VoidRequest.find({ createdAt: inDay })
        .populate({ path: "receipt", select: "billId branch" })
        .populate("requestedBy", "fullName").populate("reviewedBy", "fullName")
        .sort({ createdAt: 1 }).lean(),
      Receipt.aggregate([
        { $match: { status: { $in: SOLD }, paidAt: inDay, ...branchMatch } },
        { $unwind: "$items" },
        { $match: BELOW },
        { $sort: { paidAt: 1 } },
        { $project: { billId: 1, paidAt: 1, cashierName: 1, item: "$items" } },
      ]),
      // Bills given on credit this day (already part of the day's sales)
      Receipt.aggregate([
        { $match: { status: { $in: SOLD }, paidAt: inDay, ...branchMatch } },
        { $unwind: "$payments" },
        { $match: { "payments.method": "credit" } },
        { $group: { _id: null, amount: { $sum: "$payments.amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    // --- the day itself ---
    const t = salesRows.find((x) => x._id === date) || { net: 0, cost: 0 };
    const gross = t.net - t.cost;
    const todayLoss = {};
    lossRows.filter((l) => l._id.day === date).forEach((l) => { todayLoss[l._id.reason] = { cost: l.cost, count: l.count }; });
    const stockLoss = sumBy(Object.values(todayLoss), (x) => x.cost);
    const petty = pettyRows.find((p) => p._id === date)?.amount || 0;
    const result = gross - stockLoss - petty;

    // --- the 30 days before (days that actually traded) ---
    const prior = salesRows.filter((x) => x._id < date);
    const n = prior.length;
    const hasBaseline = n >= 5;
    const bGross = hasBaseline ? sumBy(prior, (x) => x.net - x.cost) / n : 0;
    const bSales = hasBaseline ? sumBy(prior, (x) => x.net) / n : 0;
    const bPetty = hasBaseline ? sumBy(pettyRows.filter((p) => p._id < date), (p) => p.amount) / n : 0;
    const bReason = {};
    if (hasBaseline) lossRows.filter((l) => l._id.day < date).forEach((l) => { bReason[l._id.reason] = (bReason[l._id.reason] || 0) + l.cost / n; });

    const causes = [];
    Object.entries(todayLoss).forEach(([reason, v]) => {
      const normal = bReason[reason] || 0;
      causes.push({
        key: `loss-${reason}`, label: `Stock lost: ${nice(reason)}`, actual: r0(v.cost), normal: r0(normal), impact: v.cost - normal,
        why: `${v.count} approved report${v.count > 1 ? "s" : ""}. This reason usually costs about ${kes(normal)} a day.`,
      });
    });
    if (hasBaseline) {
      const lower = t.net < bSales ? "lower" : "higher";
      causes.push({
        key: "gross", label: "Profit from selling goods was lower than usual", actual: r0(gross), normal: r0(bGross), impact: bGross - gross,
        why: `Sales were ${kes(t.net)} against about ${kes(bSales)} on a usual day (${Math.abs((t.net / (bSales || 1) - 1) * 100).toFixed(0)}% ${lower}).${belowLines.length ? " Sales below cost took a further part of the margin." : ""}`,
      });
      causes.push({
        key: "petty", label: "Petty cash spent", actual: r0(petty), normal: r0(bPetty), impact: petty - bPetty,
        why: "More cash than usual was taken out of the till for small expenses.",
      });
    }
    const threshold = Math.max(50, Math.abs(result) * 0.01);
    const ranked = causes.filter((c) => c.impact > threshold).sort((a, b) => b.impact - a.impact)
      .map((c) => ({ ...c, impact: r0(c.impact) }));

    res.json({
      date,
      vatOn: !!vatCfg.enabled,
      sales: r0(t.net),
      creditGiven: r0(creditRows[0]?.amount),
      creditCount: creditRows[0]?.count || 0,
      grossProfit: r0(gross),
      stockLoss: r0(stockLoss),
      pettyCash: r0(petty),
      result: r0(result),
      pendingReports: adjustments.filter((a) => a.status === "pending").length,
      hasBaseline,
      causes: ranked,
      records: {
        losses: adjustments.map((a) => ({
          id: `ADJ-${String(a._id).slice(-5).toUpperCase()}`, time: a.createdAt, product: a.product?.name || "Item",
          qty: a.quantity, reason: a.reason, cost: a.costImpact, by: a.requestedBy?.fullName || "Unknown",
          reviewer: a.reviewedBy?.fullName || "", status: a.status, photo: !!a.photoUrl, note: a.note || "",
        })),
        voids: voids
          .filter((v) => !branch || String(v.receipt?.branch) === String(branch))
          .map((v) => ({
            bill: v.receipt?.billId || "-", time: v.createdAt, amount: r0(sumBy(v.voidItems || [], (i) => i.lineTotal)),
            reason: v.reason, by: v.requestedBy?.fullName || "Unknown", reviewer: v.reviewedBy?.fullName || "", status: v.status,
          })),
        below: belowLines.map((b) => ({
          bill: b.billId, time: b.paidAt, product: b.item.productName, qty: b.item.quantity,
          sold: r0(b.item.unitPrice), cost: r0(b.item.costPriceAtSale),
          loss: r0((b.item.costPriceAtSale - b.item.unitPrice) * b.item.quantity), by: b.cashierName || "Unknown",
        })),
      },
    });
    logSuccess("analytics", "Day report loaded", { date });
  } catch (error) {
    next(error);
  }
};

// GET /api/analytics/till  ->  closed shifts: expected vs counted cash
export const getTill = async (req, res, next) => {
  try {
    const { start, end, branch } = scope(req.query);
    const rows = await loadTillRows(branch, start, end);
    res.json({ rows: rows.slice(0, 15) });
  } catch (error) {
    next(error);
  }
};

// GET /api/analytics/staff  ->  sales, credit given, voids and loss reports per person
export const getStaff = async (req, res, next) => {
  try {
    const { start, end, branch, branchMatch } = scope(req.query);
    const [salesRows, voids, adjustments] = await Promise.all([
      Receipt.aggregate([
        { $match: { status: { $in: SOLD }, paidAt: { $gte: start, $lte: end }, ...branchMatch } },
        {
          $group: {
            _id: "$cashierName",
            sales: { $sum: "$subtotal" },
            // value of bills this person gave on credit
            creditGiven: {
              $sum: {
                $reduce: {
                  input: { $ifNull: ["$payments", []] },
                  initialValue: 0,
                  in: { $add: ["$$value", { $cond: [{ $eq: ["$$this.method", "credit"] }, "$$this.amount", 0] }] },
                },
              },
            },
          },
        },
      ]),
      VoidRequest.find({ status: "approved", createdAt: { $gte: start, $lte: end } })
        .populate({ path: "receipt", select: "branch" }).populate("requestedBy", "fullName").lean(),
      StockAdjustment.find({ createdAt: { $gte: start, $lte: end }, ...branchMatch })
        .populate("requestedBy", "fullName").select("requestedBy status costImpact").lean(),
    ]);

    const rows = {};
    const row = (name) => (rows[name] ||= { name, sales: 0, creditGiven: 0, voidCount: 0, voidAmount: 0, lossReports: 0, lossCost: 0 });
    salesRows.forEach((s) => {
      if (!s._id) return;
      const o = row(s._id);
      o.sales = s.sales;
      o.creditGiven = s.creditGiven || 0;
    });
    voids
      .filter((v) => !branch || String(v.receipt?.branch) === String(branch))
      .forEach((v) => {
        const o = row(v.requestedBy?.fullName || "Unknown");
        o.voidCount += 1;
        o.voidAmount += sumBy(v.voidItems || [], (i) => i.lineTotal);
      });
    adjustments.forEach((a) => {
      const o = row(a.requestedBy?.fullName || "Unknown");
      o.lossReports += 1;
      if (a.status === "approved") o.lossCost += a.costImpact || 0;
    });

    const list = Object.values(rows).sort((a, b) => b.sales - a.sales).map((o) => ({
      ...o, sales: r0(o.sales), creditGiven: r0(o.creditGiven), voidAmount: r0(o.voidAmount), lossCost: r0(o.lossCost),
    }));
    const totalSales = sumBy(list, (o) => o.sales);
    res.json({ rows: list, avgVoidRate: totalSales ? (sumBy(list, (o) => o.voidAmount) / totalSales) * 100 : 0 });
  } catch (error) {
    next(error);
  }
};

// GET /api/analytics/audit?type=All|Stock loss|Void|Below-cost sale|Till difference&limit=
export const getAudit = async (req, res, next) => {
  try {
    const { start, end, branch, branchMatch } = scope(req.query);
    const type = req.query.type || "All";
    const limit = Math.min(100, Number(req.query.limit) || 15);
    const want = (t) => type === "All" || type === t;
    const range = { $gte: start, $lte: end };
    const events = [];

    if (want("Stock loss")) {
      const adj = await StockAdjustment.find({ createdAt: range, ...branchMatch })
        .populate("product", "name").populate("requestedBy", "fullName").sort({ createdAt: -1 }).limit(300).lean();
      adj.forEach((a) => events.push({
        ts: a.createdAt, type: "Stock loss", date: dayKey(a.createdAt),
        what: `${a.quantity} x ${a.product?.name || "item"}, ${nice(a.reason)}${a.costImpact ? `, ${kes(a.costImpact)}` : ""} (${a.status})`,
        by: a.requestedBy?.fullName || "Unknown", ref: `ADJ-${String(a._id).slice(-5).toUpperCase()}`,
      }));
    }
    if (want("Void")) {
      const vs = await VoidRequest.find({ createdAt: range })
        .populate({ path: "receipt", select: "billId branch" }).populate("requestedBy", "fullName").sort({ createdAt: -1 }).limit(300).lean();
      vs.filter((v) => !branch || String(v.receipt?.branch) === String(branch)).forEach((v) => events.push({
        ts: v.createdAt, type: "Void", date: dayKey(v.createdAt),
        what: `Bill ${v.receipt?.billId || "-"} void for ${kes(sumBy(v.voidItems || [], (i) => i.lineTotal))}: ${v.reason} (${v.status})`,
        by: v.requestedBy?.fullName || "Unknown", ref: v.receipt?.billId || "-",
      }));
    }
    if (want("Below-cost sale")) {
      const lines = await Receipt.aggregate([
        { $match: { status: { $in: SOLD }, paidAt: range, ...branchMatch } },
        { $unwind: "$items" },
        { $match: BELOW },
        { $sort: { paidAt: -1 } },
        { $limit: 200 },
        { $project: { billId: 1, paidAt: 1, cashierName: 1, item: "$items" } },
      ]);
      lines.forEach((b) => events.push({
        ts: b.paidAt, type: "Below-cost sale", date: dayKey(b.paidAt),
        what: `${b.item.quantity} x ${b.item.productName} sold at ${kes(b.item.unitPrice)}, cost ${kes(b.item.costPriceAtSale)}`,
        by: b.cashierName || "Unknown", ref: b.billId,
      }));
    }
    if (want("Till difference")) {
      (await loadTillRows(branch, start, end)).filter((r) => Math.abs(r.difference) > 50).forEach((r) => events.push({
        ts: r.closedAt, type: "Till difference", date: r.date,
        what: `Till ${r.difference < 0 ? "short" : "over"} by ${kes(Math.abs(r.difference))} at close`,
        by: r.cashier, ref: `SHIFT-${String(r.shiftId).slice(-5).toUpperCase()}`,
      }));
    }

    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    res.json({ total: events.length, events: events.slice(0, limit) });
  } catch (error) {
    next(error);
  }
};
