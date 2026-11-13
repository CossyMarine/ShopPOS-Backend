// controllers/dashboardController.js
//
// One endpoint powers the whole admin dashboard. All bucketing, comparisons
// and totals are done here (in the store's own timezone, from Settings), so
// the browser never downloads raw receipts.
//
// Customers = number of paid receipts (126 receipts = 126 customers).

import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Product from "../models/Product.js";
import Branch from "../models/Branch.js";
import VoidRequest from "../models/VoidRequest.js";
import WageProfile from "../models/WageProfile.js";
import AdminSettings from "../models/AdminSettings.js";
import { estimateMonthlyGross } from "./payrollController.js";
import { costEstimationStages } from "./analyticsController.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";
import { badRequest, forbidden } from "../utils/AppError.js";

const { ObjectId } = mongoose.Types;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RANGES = ["today", "week", "month", "year", "all"];
const FALLBACK = { timezone: "Africa/Nairobi", openHour: 8, closeHour: 21, currency: "KES" };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const pct = (a, b) => (b > 0 ? (a / b - 1) * 100 : null);
const hr = (h) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
const ord = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/* ---------- timezone helpers (work for any IANA zone) ---------- */
const safeTz = (tz) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return FALLBACK.timezone; }
};
const dtfs = {};
const parts = (date, tz) => {
  dtfs[tz] ||= new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  });
  const o = {};
  dtfs[tz].formatToParts(date).forEach((p) => { if (p.type !== "literal") o[p.type] = +p.value; });
  return o;
};
const offsetMs = (date, tz) => {
  const p = parts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
};
// Local midnight (in tz) of y-m-d, as a UTC Date. m is 0-based; d may overflow.
const zoned = (tz, y, m, d) => {
  const g = Date.UTC(y, m, d);
  return new Date(g - offsetMs(new Date(g), tz));
};
const mkRef = (y, m, d, hour = 23) => {
  const t = new Date(Date.UTC(y, m, d));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), hour };
};

/* ---------- period definitions ---------- */
function buildPeriod(key, ref, cur, ctx) {
  const { tz, open, close, earliest } = ctx;
  const { y, m, d } = ref;
  const todayMs = Date.UTC(y, m, d);
  const dow = (new Date(todayMs).getUTCDay() + 6) % 7;
  const hrs = close - open + 1;
  const dayN = (p) => Date.UTC(p.year, p.month - 1, p.day);
  const start = (yy, mm, dd) => zoned(tz, yy, mm, dd);
  const endBefore = (yy, mm, dd) => new Date(zoned(tz, yy, mm, dd).getTime() - 1);

  if (key === "today") return {
    hourly: true, title: "Today", sub: `Hourly, ${hr(open)} to ${hr(close)}`, cmp: "yesterday",
    labels: Array.from({ length: hrs }, (_, i) => hr(open + i)),
    now: cur ? clamp(ref.hour - open, 0, hrs - 1) : hrs - 1,
    idx: (p) => (dayN(p) === todayMs ? clamp(p.hour - open, 0, hrs - 1) : -1),
    start: start(y, m, d), end: endBefore(y, m, d + 1), from: ymd(todayMs), to: ymd(todayMs),
  };
  if (key === "week") {
    const mon = Date.UTC(y, m, d - dow);
    return {
      title: "This Week", sub: "Monday to Sunday", cmp: "last week",
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], now: cur ? dow : 6,
      idx: (p) => { const k = Math.round((dayN(p) - mon) / 864e5); return k >= 0 && k < 7 ? k : -1; },
      start: start(y, m, d - dow), end: endBefore(y, m, d - dow + 7), from: ymd(mon), to: ymd(mon + 6 * 864e5),
    };
  }
  if (key === "month") {
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return {
      title: "This Month", sub: `${MON[m]} ${y}, by day`, cmp: "last month",
      labels: Array.from({ length: dim }, (_, i) => ord(i + 1)), now: cur ? d - 1 : dim - 1,
      idx: (p) => (p.year === y && p.month - 1 === m ? p.day - 1 : -1),
      start: start(y, m, 1), end: endBefore(y, m + 1, 1), from: ymd(Date.UTC(y, m, 1)), to: ymd(Date.UTC(y, m, dim)),
    };
  }
  if (key === "year") return {
    title: "This Year", sub: `January to December ${y}`, cmp: "last year", labels: MON, now: cur ? m : 11,
    idx: (p) => (p.year === y ? p.month - 1 : -1),
    start: start(y, 0, 1), end: endBefore(y + 1, 0, 1), from: ymd(Date.UTC(y, 0, 1)), to: ymd(Date.UTC(y, 11, 31)),
  };
  // all time — monthly buckets, or yearly once history exceeds 3 years
  const sy = earliest.y, sm = earliest.m, months = (y - sy) * 12 + m - sm + 1;
  const common = {
    title: "All Time", cmp: null, start: start(sy, sm, 1), end: endBefore(y, m, d + 1),
    from: "2000-01-01", to: ymd(todayMs),
  };
  if (months <= 36) return {
    ...common, sub: `Monthly, since ${MON[sm]} ${sy}`,
    labels: Array.from({ length: months }, (_, i) => `${MON[(sm + i) % 12]} ${String(sy + Math.floor((sm + i) / 12)).slice(2)}`),
    now: months - 1,
    idx: (p) => { const k = (p.year - sy) * 12 + p.month - 1 - sm; return k >= 0 && k < months ? k : -1; },
  };
  return {
    ...common, sub: `Yearly, since ${sy}`,
    labels: Array.from({ length: y - sy + 1 }, (_, i) => String(sy + i)), now: y - sy,
    idx: (p) => { const k = p.year - sy; return k >= 0 && k <= y - sy ? k : -1; },
  };
}

// rows grouped by {y,m,d[,h]} -> arrays aligned to the period's buckets
const fill = (rows, P, fields) => {
  const out = fields.map(() => Array(P.labels.length).fill(0));
  rows.forEach((r) => {
    const i = P.idx({ year: r._id.y, month: r._id.m, day: r._id.d, hour: r._id.h ?? 0 });
    if (i < 0) return;
    fields.forEach((f, k) => { out[k][i] += r[f] || 0; });
  });
  return out;
};

/* ---------- GET /api/analytics/dashboard?range=&branch= ---------- */
export const getDashboard = async (req, res, next) => {
  try {
    const key = RANGES.includes(req.query.range) ? req.query.range : "today";

    // Super Admin may pick any branch (or all). Everyone else is locked to their own.
    const branch = req.user.isAdmin ? (req.query.branch || null) : (req.user.branch ? String(req.user.branch) : null);
    if (!req.user.isAdmin && !branch) throw forbidden("Your account has no assigned branch");
    if (branch && !mongoose.isValidObjectId(branch)) throw badRequest("Invalid branch id");
    const branchMatch = branch ? { branch: new ObjectId(branch) } : {};

    logStart("dashboard", "Loading dashboard", { range: key, branch: branch || "all" });

    const s = await AdminSettings.getSettings();
    const tz = safeTz(s.timezone || FALLBACK.timezone);
    let open = s.openHour ?? FALLBACK.openHour, close = s.closeHour ?? FALLBACK.closeHour;
    if (close <= open) { open = FALLBACK.openHour; close = FALLBACK.closeHour; }
    const hrs = close - open + 1;

    const np = parts(new Date(), tz);
    const nowRef = { y: np.year, m: np.month - 1, d: np.day, hour: np.hour };

    let earliest = nowRef;
    if (key === "all") {
      const first = await Receipt.findOne({ status: "paid", paidAt: { $ne: null }, ...branchMatch })
        .sort({ paidAt: 1 }).select("paidAt").lean();
      if (first?.paidAt) {
        const fp = parts(first.paidAt, tz);
        earliest = { y: fp.year, m: fp.month - 1, d: fp.day, hour: 0 };
      }
    }

    const ctx = { tz, open, close, earliest };
    const prevRef = {
      today: mkRef(nowRef.y, nowRef.m, nowRef.d - 1),
      week: mkRef(nowRef.y, nowRef.m, nowRef.d - 7),
      month: mkRef(nowRef.y, nowRef.m, 0),
      year: { y: nowRef.y - 1, m: 5, d: 15, hour: 23 },
      all: null,
    }[key];
    const C = buildPeriod(key, nowRef, true, ctx);
    const V = prevRef ? buildPeriod(key, prevRef, false, ctx) : null;

    const windowStart = V ? V.start : C.start;
    const winMatch = { status: "paid", paidAt: { $gte: windowStart, $lte: C.end }, ...branchMatch };
    const curMatch = { status: "paid", paidAt: { $gte: C.start, $lte: C.end }, ...branchMatch };
    const todayStart = zoned(tz, nowRef.y, nowRef.m, nowRef.d);
    const todayEnd = new Date(zoned(tz, nowRef.y, nowRef.m, nowRef.d + 1).getTime() - 1);

    const dp = { $dateToParts: { date: "$paidAt", timezone: tz } };
    const gid = C.hourly
      ? { y: "$p.year", m: "$p.month", d: "$p.day", h: "$p.hour" }
      : { y: "$p.year", m: "$p.month", d: "$p.day" };
    const lookupProduct = [
      { $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "product" } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    ];

    const [
      revRows, profRows, payRows, heatRows, topRows, branchRows, recent, voidedRows,
      pendingVoidRows, pendingPayRows, lowRows, wageProfiles,
    ] = await Promise.all([
      // revenue + receipts (customers) per bucket, current AND previous period
      Receipt.aggregate([
        { $match: winMatch }, { $addFields: { p: dp } },
        { $group: { _id: gid, revenue: { $sum: "$subtotal" }, count: { $sum: 1 } } },
      ]),
      // item-level revenue/cost per bucket, for profit
      Receipt.aggregate([
        { $match: winMatch }, { $addFields: { p: dp } }, { $unwind: "$items" }, ...lookupProduct,
        ...costEstimationStages(),
        { $group: { _id: gid, revenue: { $sum: "$items.lineTotal" }, cost: { $sum: "$lineCost" } } },
      ]),
      Receipt.aggregate([
        { $match: curMatch },
        { $group: { _id: "$paymentMethod", amount: { $sum: "$subtotal" } } },
        { $sort: { amount: -1 } },
      ]),
      // busiest weekday x hour (ISO: 1 = Monday)
      Receipt.aggregate([
        { $match: curMatch },
        { $group: {
          _id: { dow: { $isoDayOfWeek: { date: "$paidAt", timezone: tz } }, h: { $hour: { date: "$paidAt", timezone: tz } } },
          count: { $sum: 1 },
        } },
      ]),
      Receipt.aggregate([
        { $match: curMatch }, { $unwind: "$items" },
        { $group: {
          _id: { $ifNull: ["$items.productId", "$items.productName"] },
          productName: { $first: "$items.productName" },
          unitsSold: { $sum: "$items.quantity" },
          revenue: { $sum: "$items.lineTotal" },
        } },
        { $sort: { revenue: -1 } }, { $limit: 5 },
      ]),
      // branch comparison — only for Super Admin looking at all branches
      branch || !req.user.isAdmin ? Promise.resolve([]) : Receipt.aggregate([
        { $match: curMatch }, { $unwind: "$items" }, ...lookupProduct, ...costEstimationStages(),
        { $group: { _id: "$branch", revenue: { $sum: "$items.lineTotal" }, cost: { $sum: "$lineCost" } } },
        { $sort: { revenue: -1 } },
      ]),
      Receipt.find({ ...branchMatch })
        .sort({ createdAt: -1 }).limit(8).populate("branch", "name")
        .select("billId cashierName branch createdAt status subtotal paymentMethod cashAmount tillAmount changeGiven mpesaReceiptNumber paidAt items")
        .lean(),
      Receipt.aggregate([
        { $match: { status: "voided", updatedAt: { $gte: todayStart, $lte: todayEnd }, ...branchMatch } },
        { $group: { _id: null, amount: { $sum: "$subtotal" }, count: { $sum: 1 } } },
      ]),
      VoidRequest.find({ status: "pending" })
        .populate({ path: "receipt", select: "_id", ...(branch ? { match: { branch } } : {}) })
        .select("receipt").lean(),
      Receipt.aggregate([
        { $match: { "pendingManualPayments.0": { $exists: true }, ...branchMatch } },
        { $group: { _id: null, count: { $sum: { $size: { $ifNull: ["$pendingManualPayments", []] } } } } },
      ]),
      Product.aggregate([
        { $match: { isActive: true, ...branchMatch } },
        { $addFields: { currentStock: { $sum: "$batches.quantity" } } },
        { $match: { $expr: { $lte: ["$currentStock", "$reorderLevel"] } } },
        { $addFields: { ratio: { $divide: ["$currentStock", { $max: ["$reorderLevel", 1] }] } } },
        { $facet: {
          count: [{ $count: "n" }],
          items: [
            { $sort: { ratio: 1, name: 1 } }, { $limit: 8 },
            { $lookup: { from: "inventoryunits", localField: "unit", foreignField: "_id", as: "u" } },
            { $project: { _id: 0, name: 1, stock: "$currentStock", level: "$reorderLevel",
              unit: { $ifNull: [{ $arrayElemAt: ["$u.abbreviation", 0] }, ""] } } },
          ],
        } },
      ]),
      WageProfile.find(branch ? { branch: new ObjectId(branch) } : {}).populate("user", "isActive").lean(),
    ]);

    /* ----- series ----- */
    const cut = (a) => a.map((v, i) => (i > C.now ? null : r2(v)));
    const [cRev, cCnt] = fill(revRows, C, ["revenue", "count"]);
    const [cLine, cCost] = fill(profRows, C, ["revenue", "cost"]);
    const cProfit = cLine.map((v, i) => v - cCost[i]);
    const series = { cur: { revenue: cut(cRev), customers: cut(cCnt), profit: cut(cProfit) }, prev: null };

    let deltas = { revenue: null, customers: null, profit: null };
    if (V) {
      const [pRev, pCnt] = fill(revRows, V, ["revenue", "count"]);
      const [pLine, pCost] = fill(profRows, V, ["revenue", "cost"]);
      const pProfit = pLine.map((v, i) => v - pCost[i]);
      series.prev = { revenue: pRev.map(r2), customers: pCnt, profit: pProfit.map(r2) };
      // like-for-like: previous period only up to the same hour/day as now
      const upto = (a) => sum(a.slice(0, C.now + 1));
      deltas = {
        revenue: pct(sum(cRev), upto(pRev)),
        customers: pct(sum(cCnt), upto(pCnt)),
        profit: pct(sum(cProfit), upto(pProfit)),
      };
    }

    const revenue = sum(cRev), customers = sum(cCnt), profit = sum(cProfit), lineRev = sum(cLine);

    /* ----- heat map ----- */
    const heat = Array.from({ length: 7 }, () => Array(hrs).fill(0));
    heatRows.forEach((r) => { heat[r._id.dow - 1][clamp(r._id.h - open, 0, hrs - 1)] += r.count; });

    /* ----- branches ----- */
    let branches = [];
    if (branchRows.length > 1) {
      const names = await Branch.find({ _id: { $in: branchRows.map((b) => b._id) } }).select("name").lean();
      const nm = Object.fromEntries(names.map((b) => [String(b._id), b.name]));
      branches = branchRows.map((b) => ({
        branchId: b._id, branchName: nm[String(b._id)] || "Unknown",
        revenue: Math.round(b.revenue), profit: Math.round(b.revenue - b.cost),
      }));
    }

    const low = lowRows[0] || { count: [], items: [] };
    const voided = voidedRows[0] || { amount: 0, count: 0 };
    const nextPayroll = Math.round(
      wageProfiles.filter((w) => w.user?.isActive).reduce((t, w) => t + estimateMonthlyGross(w), 0)
    );

    logSuccess("dashboard", "Dashboard loaded", { range: key, revenue, customers });

    res.json({
      store: { name: s.storeName || "", currency: s.currency || FALLBACK.currency, timezone: tz, openHour: open, closeHour: close },
      period: { key, title: C.title, sub: C.sub, cmp: C.cmp, labels: C.labels, now: C.now },
      query: { range: "custom", from: C.from, to: C.to }, // forwarded to /category-margin
      series,
      totals: {
        revenue: Math.round(revenue), customers, profit: Math.round(profit),
        marginPct: lineRev > 0 ? (profit / lineRev) * 100 : 0,
        avgBasket: customers > 0 ? Math.round(revenue / customers) : 0,
      },
      deltas,
      payments: payRows.map((p) => ({ method: p._id || "unknown", amount: Math.round(p.amount) })),
      heat,
      topItems: topRows.map((i) => ({ productName: i.productName, unitsSold: i.unitsSold, revenue: Math.round(i.revenue) })),
      branches,
      recent,
      lowStock: { count: low.count[0]?.n || 0, items: low.items },
      voided: { amount: Math.round(voided.amount), count: voided.count },
      pendingVoids: pendingVoidRows.filter((v) => v.receipt).length,
      pendingPayments: pendingPayRows[0]?.count || 0,
      nextPayroll,
    });
  } catch (error) {
    next(error);
  }
};
