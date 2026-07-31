// controllers/revenueController.js
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Product from "../models/Product.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";

const formatHourLabel = (hour) => {
  const period = hour >= 12 ? "PM" : "AM";
  let hr = hour % 12;
  if (hr === 0) hr = 12;
  return `${hr} ${period}`;
};

// @desc    Get total revenue and paid receipt count for today, optionally
//          scoped to one branch (?branch=<id>) — powers the Public Customer
//          Display idle-loop stat and the Cashier dashboard header.
// @route   GET /api/revenue/today?branch=
// @access  Public
export const getTodayRevenue = async (req, res) => {
  try {
    const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();
    const branchMatch = req.query.branch ? { branch: new mongoose.Types.ObjectId(req.query.branch) } : {};

    const result = await Receipt.aggregate([
      {
        $match: {
          status: "paid",
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

    res.json({
      totalRevenue: data.totalRevenue,
      paidReceiptsCount: data.paidReceiptsCount,
    });
  } catch (error) {
    console.error("Error fetching today's revenue:", error.message);
    res.status(500).json({ message: "Failed to fetch revenue data", error: error.message });
  }
};

// @desc    Get all-time total revenue and total receipt count — Dashboard
//          Overview cards. Super Admin can omit ?branch= for the "all
//          branches" combined figure, or pass it to drill into one branch.
// @route   GET /api/revenue/summary?branch=
// @access  Protected — admin, branchManager (auto-scoped via sameBranch)
export const getRevenueSummary = async (req, res) => {
  try {
    const branchMatch = req.query.branch ? { branch: new mongoose.Types.ObjectId(req.query.branch) } : {};

    const result = await Receipt.aggregate([
      { $match: { status: "paid", ...branchMatch } },
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

    res.json({
      totalRevenue: data.totalRevenue,
      totalPaidReceipts: data.totalPaidReceipts,
      totalReceipts,
    });
  } catch (error) {
    console.error("Error fetching revenue summary:", error.message);
    res.status(500).json({ message: "Failed to fetch revenue summary", error: error.message });
  }
};

// @desc    Powers the dashboard visuals: hourly sales trend, payment method
//          breakdown, category share, low stock count, refunds/voids today,
//          and net profit — scoped to today (Kenyan calendar day) and
//          optionally one branch (?branch=<id>).
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
// @route   GET /api/revenue/dashboard-stats?branch=
// @access  Protected — admin, branchManager
export const getDashboardStats = async (req, res) => {
  try {
    const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();
    const branchMatch = req.query.branch ? { branch: new mongoose.Types.ObjectId(req.query.branch) } : {};
    const paidTodayMatch = {
      status: "paid",
      paidAt: { $gte: startOfDay, $lte: endOfDay },
      ...branchMatch,
    };

    const [hourlyRaw, paymentRaw, categoryRaw, lowStockAgg, profitAgg, voidedAgg] = await Promise.all([
      // Hourly revenue trend (Kenyan wall-clock hour)
      Receipt.aggregate([
        { $match: paidTodayMatch },
        {
          $group: {
            _id: { $hour: { date: "$paidAt", timezone: "Africa/Nairobi" } },
            revenue: { $sum: "$subtotal" },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Payment method breakdown
      Receipt.aggregate([
        { $match: paidTodayMatch },
        { $group: { _id: "$paymentMethod", amount: { $sum: "$subtotal" } } },
        { $sort: { amount: -1 } },
      ]),

      // Category share (join items -> products for category)
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
          $group: {
            _id: { $ifNull: ["$product.category", "Uncategorized"] },
            amount: { $sum: "$items.lineTotal" },
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

      // Net profit — exact where costPriceAtSale exists, estimated otherwise
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
            // Fallback estimate only used when costPriceAtSale is missing —
            // quantity-weighted average of the product's current remaining
            // batches, or the sale's own unitPrice (0 margin) if none exist.
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
        {
          $group: {
            _id: null,
            revenue: { $sum: "$items.lineTotal" },
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

    const hourMap = {};
    hourlyRaw.forEach((h) => { hourMap[h._id] = h.revenue; });
    const hourlyTrend = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: formatHourLabel(h),
      revenue: hourMap[h] || 0,
    }));

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

    res.json({
      hourlyTrend,
      paymentBreakdown: paymentRaw.map((p) => ({ method: p._id || "unknown", amount: p.amount })),
      categoryBreakdown,
      lowStockCount: lowStockAgg[0]?.count || 0,
      netProfit,
      netProfitMargin,
      voidedToday: { amount: voided.amount, count: voided.count },
    });
  } catch (error) {
    console.error("Error fetching dashboard stats:", error.message);
    res.status(500).json({ message: "Failed to fetch dashboard stats", error: error.message });
  }
};
