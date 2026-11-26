// controllers/revenueController.js
//
// A "sale" is a receipt that is paid OR given on credit, dated by
// receipt.paidAt (for credit bills: the day the credit was given).
//
// VAT: net profit and the category breakdown use lineNet (the amount before
// VAT), exactly like the Analytics page. When VAT is off, lineNet is just
// lineTotal and nothing changes.
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Product from "../models/Product.js";
import AdminSettings from "../models/AdminSettings.js"; // VAT
import { getKenyanDayBounds, getKenyanMonthBounds } from "../utils/dateHelpers.js";
import { salesStages } from "../utils/vatReport.js"; // VAT
import { logStart, logSuccess } from "../utils/requestLogger.js";

// Receipt statuses that count as a sale.
const SOLD = ["paid", "credit"];

// "1st", "2nd", "3rd", "12th", "21st" ...
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

// @desc    Get total revenue and sold receipt count (paid + credit) for
//          today, optionally scoped to one branch (?branch=<id>) — powers the
//          Public Customer Display idle-loop stat and the Cashier dashboard
//          header.
// @route   GET /api/revenue/today?branch=
// @access  Public
export const getTodayRevenue = async (req, res, next) => {
  try {
    logStart("revenue", "Loading today's revenue", { branch: req.query.branch || "all" });

    const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();
    const branchMatch = req.query.branch ? { branch: new mongoose.Types.ObjectId(req.query.branch) } : {};

    const result = await Receipt.aggregate([
      {
        $match: {
          status: { $in: SOLD },
          paidAt: { $gte: startOfDay, $lte: endOfDay },
          ...branchMatch,
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$subtotal" },
          paidReceiptsCount: { $sum: 1 },
        },
      },
    ]);

    const data = result[0] || { totalRevenue: 0, paidReceiptsCount: 0 };

    logSuccess("revenue", "Today's revenue loaded", data);
    res.json({
      totalRevenue: data.totalRevenue,
      paidReceiptsCount: data.paidReceiptsCount,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all-time total revenue and total receipt count — Dashboard
//          Overview cards. Super Admin can omit ?branch= for the "all
//          branches" combined figure, or pass it to drill into one branch.
//          Credit bills count as sold (totalPaidReceipts includes them).
// @route   GET /api/revenue/summary?branch=
// @access  Protected — admin, branchManager (auto-scoped via sameBranch)
export const getRevenueSummary = async (req, res, next) => {
  try {
    logStart("revenue", "Loading revenue summary", { branch: req.query.branch || "all" });

    const branchMatch = req.query.branch ? { branch: new mongoose.Types.ObjectId(req.query.branch) } : {};

    const result = await Receipt.aggregate([
      { $match: { status: { $in: SOLD }, ...branchMatch } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$subtotal" },
          totalPaidReceipts: { $sum: 1 },
        },
      },
    ]);

    const totalReceipts = await Receipt.countDocuments(branchMatch);
    const data = result[0] || { totalRevenue: 0, totalPaidReceipts: 0 };

    logSuccess("revenue", "Revenue summary loaded", { ...data, totalReceipts });
    res.json({
      totalRevenue: data.totalRevenue,
      totalPaidReceipts: data.totalPaidReceipts,
      totalReceipts,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Powers the dashboard visuals: daily sales trend for the current
//          month, payment method breakdown, category share, low stock
//          count, refunds/voids today, and net profit — scoped to the
//          Kenyan calendar month-to-date (trend/payment/category/month
//          total) or the Kenyan calendar day (low stock, voids, net
//          profit), and optionally one branch (?branch=<id>).
//
//          NOTE on netProfit: every sale going forward stamps the REAL
//          buying price onto each line at the moment of sale
//          (items.costPriceAtSale — see deductStockFIFO). This aggregation
//          uses that exact value whenever it's present. It only falls back
//          to estimating from the product's *current* remaining batch cost
//          for old receipts that predate this field — and if even that's
//          unavailable (product since sold out / deleted), it assumes 0
//          margin for that line rather than guessing a number that could
//          overstate profit.
//
//          NOTE on credit: bills given on credit count as sales on the day
//          they were given, and stay under "credit" in the payment
//          breakdown even after the customer has settled them.
//
//          NOTE on VAT: netProfit and the category share work on the amount
//          before VAT (lineNet), the same as the Analytics page.
// @route   GET /api/revenue/dashboard-stats?branch=
// @access  Protected — admin, branchManager
export const getDashboardStats = async (req, res, next) => {
  try {
    logStart("revenue", "Loading dashboard stats", { branch: req.query.branch || "all" });

    const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();
    const { start: startOfMonth, end: endOfMonth } = getKenyanMonthBounds();
    const branchMatch = req.query.branch ? { branch: new mongoose.Types.ObjectId(req.query.branch) } : {};

    // VAT: lineNet / lineVat / linePaid for every line (lineNet = lineTotal when VAT is off)
    const vatCfg = (await AdminSettings.getSettings()).vat || {};
    const sales = salesStages(!!vatCfg.enabled, vatCfg.rate);

    const paidTodayMatch = {
      status: { $in: SOLD },
      paidAt: { $gte: startOfDay, $lte: endOfDay },
      ...branchMatch,
    };

    // This month-to-date (Kenyan calendar month), used for the daily trend
    // chart, the payment/category breakdowns, and the "This Month's Sales"
    // stat card.
    const paidMonthMatch = {
      status: { $in: SOLD },
      paidAt: { $gte: startOfMonth, $lte: endOfMonth },
      ...branchMatch,
    };

    const [dailyRaw, monthTotalAgg, paymentRaw, categoryRaw, lowStockAgg, profitAgg, voidedAgg] = await Promise.all([
      // Daily revenue trend for the month so far (Kenyan wall-clock day)
      Receipt.aggregate([
        { $match: paidMonthMatch },
        {
          $group: {
            _id: { $dayOfMonth: { date: "$paidAt", timezone: "Africa/Nairobi" } },
            revenue: { $sum: "$subtotal" },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Month-to-date total revenue + sold receipt count ("This Month's Sales" card)
      Receipt.aggregate([
        { $match: paidMonthMatch },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$subtotal" },
            paidReceiptsCount: { $sum: 1 },
          },
        },
      ]),

      // Payment method breakdown (this month).
      // A bill that was ever given on credit is filed under "credit", even
      // once settled — settlement overwrites paymentMethod with cash/till,
      // which would otherwise move the sale out of "credit".
      Receipt.aggregate([
        { $match: paidMonthMatch },
        {
          $addFields: {
            payKey: {
              $cond: [
                { $in: ["credit", { $ifNull: ["$payments.method", []] }] },
                "credit",
                "$paymentMethod",
              ],
            },
          },
        },
        { $group: { _id: "$payKey", amount: { $sum: "$subtotal" } } },
        { $sort: { amount: -1 } },
      ]),

      // Category share (this month) — join items -> products for category
      Receipt.aggregate([
        { $match: paidMonthMatch },
        { $unwind: "$items" },
        {
          $lookup: {
            from: "products",
            localField: "items.productId",
            foreignField: "_id",
            as: "product",
          },
        },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        ...sales, // VAT
        {
          $group: {
            _id: { $ifNull: ["$product.category", "Uncategorized"] },
            amount: { $sum: "$lineNet" }, // VAT: was $items.lineTotal
          },
        },
        { $sort: { amount: -1 } },
      ]),

      // Low stock count (currentStock <= reorderLevel)
      Product.aggregate([
        {
          $match: req.query.branch
            ? { branch: new mongoose.Types.ObjectId(req.query.branch), isActive: true }
            : { isActive: true },
        },
        { $addFields: { currentStock: { $sum: "$batches.quantity" } } },
        { $match: { $expr: { $lte: ["$currentStock", "$reorderLevel"] } } },
        { $count: "count" },
      ]),

      // Net profit (today) — exact where costPriceAtSale exists, estimated otherwise
      Receipt.aggregate([
        { $match: paidTodayMatch },
        { $unwind: "$items" },
        {
          $lookup: {
            from: "products",
            localField: "items.productId",
            foreignField: "_id",
            as: "product",
          },
        },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            estimatedCost: {
              $let: {
                vars: {
                  totalQty: { $sum: { $ifNull: ["$product.batches.quantity", []] } },
                  totalCostQty: {
                    $sum: {
                      $map: {
                        input: { $ifNull: ["$product.batches", []] },
                        as: "b",
                        in: { $multiply: ["$$b.quantity", "$$b.costPerUnit"] },
                      },
                    },
                  },
                },
                in: {
                  $cond: [
                    { $gt: ["$$totalQty", 0] },
                    { $divide: ["$$totalCostQty", "$$totalQty"] },
                    "$items.unitPrice",
                  ],
                },
              },
            },
          },
        },
        {
          $addFields: {
            lineCost: {
              $cond: [
                { $ne: ["$items.costPriceAtSale", null] },
                { $multiply: ["$items.costPriceAtSale", "$items.quantity"] },
                { $multiply: ["$estimatedCost", "$items.quantity"] },
              ],
            },
          },
        },
        ...sales, // VAT
        {
          $group: {
            _id: null,
            revenue: { $sum: "$lineNet" }, // VAT: was $items.lineTotal
            cost: { $sum: "$lineCost" },
          },
        },
      ]),

      // Refunds & voids today (by when the receipt was voided)
      Receipt.aggregate([
        {
          $match: {
            status: "voided",
            updatedAt: { $gte: startOfDay, $lte: endOfDay },
            ...branchMatch,
          },
        },
        {
          $group: {
            _id: null,
            amount: { $sum: "$subtotal" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    // Build one bar per elapsed day of the month, labeled e.g. "12th June"
    const dayMap = {};
    dailyRaw.forEach((d) => { dayMap[d._id] = d.revenue; });

    const daysElapsed = endOfMonth.getDate(); // "today" is day N of the month
    const monthName = startOfMonth.toLocaleString("en-US", { month: "long" });

    const dailyTrend = Array.from({ length: daysElapsed }, (_, i) => {
      const day = i + 1;
      return {
        day,
        label: `${ordinal(day)} ${monthName}`,
        revenue: dayMap[day] || 0,
      };
    });

    const monthTotal = monthTotalAgg[0] || { totalRevenue: 0, paidReceiptsCount: 0 };

    const categoryTotal = categoryRaw.reduce((sum, c) => sum + c.amount, 0) || 1;
    const categoryBreakdown = categoryRaw.map((c) => ({
      category: c._id || "Uncategorized",
      amount: c.amount,
      percent: Math.round((c.amount / categoryTotal) * 1000) / 10,
    }));

    const profit = profitAgg[0] || { revenue: 0, cost: 0 };
    const netProfit = Math.round(profit.revenue - profit.cost);
    const netProfitMargin = profit.revenue > 0
      ? Math.round((netProfit / profit.revenue) * 1000) / 10
      : 0;

    const voided = voidedAgg[0] || { amount: 0, count: 0 };

    logSuccess("revenue", "Dashboard stats loaded", {
      monthRevenue: monthTotal.totalRevenue,
      lowStockCount: lowStockAgg[0]?.count || 0,
      netProfit,
      voidedTodayCount: voided.count,
    });

    res.json({
      dailyTrend,
      monthRevenue: monthTotal.totalRevenue,
      monthReceiptsCount: monthTotal.paidReceiptsCount,
      paymentBreakdown: paymentRaw.map((p) => ({ method: p._id || "unknown", amount: p.amount })),
      categoryBreakdown,
      lowStockCount: lowStockAgg[0]?.count || 0,
      netProfit,
      netProfitMargin,
      voidedToday: { amount: voided.amount, count: voided.count },
    });
  } catch (error) {
    next(error);
  }
};
