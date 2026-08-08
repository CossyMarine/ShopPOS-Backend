// controllers/analyticsController.js
//
// Powers the Admin "Analytics" page: totals, top/stuck items, branch
// performance, and a full salary/profit breakdown — all filterable by
// branch (default: all branches) and by date range (today / last 7 days /
// last 30 days / this year / custom).
//
// Reuses the same costPriceAtSale-first / batch-cost-fallback profit logic
// already established in revenueController.getDashboardStats, so numbers
// stay consistent across the app.

import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Product from "../models/Product.js";
import Branch from "../models/Branch.js";
import Payslip from "../models/Payslip.js";
import WageProfile from "../models/WageProfile.js";
import { getKenyanDate, getKenyanDayBounds } from "../utils/dateHelpers.js";
import { estimateMonthlyGross } from "./payrollController.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";

const { ObjectId } = mongoose.Types;

// A product sold zero units in the range is "stuck". A product sold above
// zero but under half the average units-sold-per-active-product is
// "slow-moving". Both only apply to products that currently have stock —
// an out-of-stock item isn't "stuck", it's just sold out.
const SLOW_MOVING_RATIO = 0.5;

// ---------------------------------------------------------------------
// Date range resolution — Kenya wall-clock, fixed +03:00 offset (Kenya
// has no DST, same assumption already used by dateHelpers.js and the
// frontend's kenyanDayBound helper).
// ---------------------------------------------------------------------
export const resolveAnalyticsRange = (range, from, to) => {
  const today = getKenyanDate();
  const endOfToday = new Date(today);
  endOfToday.setHours(23, 59, 59, 999);

  switch (range) {
    case "today": {
      return getKenyanDayBounds();
    }
    case "last_7_days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end: endOfToday };
    }
    case "last_30_days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      start.setHours(0, 0, 0, 0);
      return { start, end: endOfToday };
    }
    case "year": {
      const start = new Date(today.getFullYear(), 0, 1);
      start.setHours(0, 0, 0, 0);
      return { start, end: endOfToday };
    }
    case "custom": {
      if (!from || !to) {
        throw new Error("Custom range requires both from and to (YYYY-MM-DD)");
      }
      const start = new Date(`${from}T00:00:00.000+03:00`);
      const end = new Date(`${to}T23:59:59.999+03:00`);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error("Invalid from/to date");
      }
      return { start, end };
    }
    default: {
      // Default to "today" if an unknown/missing range is passed.
      return getKenyanDayBounds();
    }
  }
};

// ---------------------------------------------------------------------
// GET /api/analytics/overview?branch=&range=today|last_7_days|last_30_days|year|custom&from=&to=
// ---------------------------------------------------------------------
export const getAnalyticsOverview = async (req, res) => {
  try {
    const { branch, range = "today", from, to } = req.query;
    logStart("analytics", "Loading analytics overview", { branch: branch || "all", range, from, to });

    const { start, end } = resolveAnalyticsRange(range, from, to);
    const branchMatch = branch ? { branch: new ObjectId(branch) } : {};

    const paidMatch = {
      status: "paid",
      paidAt: { $gte: start, $lte: end },
      ...branchMatch,
    };

    const [
      totalsAgg,
      dailyProfitAgg,
      topItemsAgg,
      soldQtyByProductAgg,
      branchPerfAgg,
      totalBranches,
      productsForStockCheck,
      salaryAgg,
      staffBreakdown,
      wageProfiles,
    ] = await Promise.all([
      // Overall revenue/cost/profit for the range
      Receipt.aggregate([
        { $match: paidMatch },
        { $unwind: "$items" },
        {
          $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "product" },
        },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        ...costEstimationStages(),
        {
          $group: {
            _id: null,
            revenue: { $sum: "$items.lineTotal" },
            cost: { $sum: "$lineCost" },
            unitsSold: { $sum: "$items.quantity" },
          },
        },
      ]),

      // Day-by-day revenue/profit for the zigzag line chart
      Receipt.aggregate([
        { $match: paidMatch },
        { $unwind: "$items" },
        {
          $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "product" },
        },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        ...costEstimationStages(),
        {
          $group: {
            _id: {
              y: { $year: { date: "$paidAt", timezone: "Africa/Nairobi" } },
              m: { $month: { date: "$paidAt", timezone: "Africa/Nairobi" } },
              d: { $dayOfMonth: { date: "$paidAt", timezone: "Africa/Nairobi" } },
            },
            revenue: { $sum: "$items.lineTotal" },
            cost: { $sum: "$lineCost" },
          },
        },
        { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
      ]),

      // Top performing items by revenue (limit 10)
      Receipt.aggregate([
        { $match: paidMatch },
        { $unwind: "$items" },
        {
          $group: {
            _id: { $ifNull: ["$items.productId", "$items.productName"] },
            productName: { $first: "$items.productName" },
            unitsSold: { $sum: "$items.quantity" },
            revenue: { $sum: "$items.lineTotal" },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
      ]),

      // Units sold per productId in range — feeds stuck/slow-moving calc
      Receipt.aggregate([
        { $match: paidMatch },
        { $unwind: "$items" },
        { $match: { "items.productId": { $ne: null } } },
        {
          $group: {
            _id: "$items.productId",
            unitsSold: { $sum: "$items.quantity" },
          },
        },
      ]),

      // Branch performance — only meaningful with >1 branch, computed always
      // and trimmed to [] in the response builder if not needed.
      Receipt.aggregate([
        { $match: paidMatch },
        { $unwind: "$items" },
        {
          $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "product" },
        },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        ...costEstimationStages(),
        {
          $group: {
            _id: "$branch",
            revenue: { $sum: "$items.lineTotal" },
            cost: { $sum: "$lineCost" },
            receiptIds: { $addToSet: "$_id" },
          },
        },
        {
          $lookup: { from: "branches", localField: "_id", foreignField: "_id", as: "branchInfo" },
        },
        { $unwind: "$branchInfo" },
        {
          $project: {
            _id: 0,
            branchId: "$_id",
            branchName: "$branchInfo.name",
            revenue: 1,
            profit: { $subtract: ["$revenue", "$cost"] },
            receiptCount: { $size: "$receiptIds" },
          },
        },
        { $sort: { revenue: -1 } },
      ]),

      Branch.countDocuments({ isActive: true }),

      // Active, in-stock products (for stuck/slow-moving detection)
      Product.aggregate([
        { $match: { isActive: true, ...branchMatch } },
        { $addFields: { currentStock: { $sum: "$batches.quantity" } } },
        { $match: { currentStock: { $gt: 0 } } },
        { $project: { name: 1, category: 1, currentStock: 1 } },
      ]),

      // Salary paid out in this range (Payslip.branch is stamped directly,
      // no need to join through User)
      Payslip.aggregate([
        {
          $match: {
            status: "paid",
            disbursedAt: { $gte: start, $lte: end },
            ...(branch ? { branch: new ObjectId(branch) } : {}),
          },
        },
        { $group: { _id: null, totalPaid: { $sum: "$netPayable" }, count: { $sum: 1 } } },
      ]),

      // Detailed staff salary breakdown for the range (explains each
      // person's pay: base, extra, commission, deductions, net)
      Payslip.find({
        status: "paid",
        disbursedAt: { $gte: start, $lte: end },
        ...(branch ? { branch } : {}),
      })
        .populate("user", "fullName role jobTitle")
        .sort({ disbursedAt: -1 })
        .lean(),

      // Active wage profiles — for the "next salary" projection
      WageProfile.find(branch ? { branch } : {})
        .populate("user", "fullName role jobTitle isActive")
        .lean(),
    ]);

    // ---- Totals ----
    const totals = totalsAgg[0] || { revenue: 0, cost: 0, unitsSold: 0 };
    const totalRevenue = Math.round(totals.revenue || 0);
    const totalProfit = Math.round((totals.revenue || 0) - (totals.cost || 0));

    // ---- Profit trend (zigzag chart) ----
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const profitTrend = dailyProfitAgg.map((d) => ({
      date: `${d._id.y}-${String(d._id.m).padStart(2, "0")}-${String(d._id.d).padStart(2, "0")}`,
      label: `${d._id.d} ${monthNames[d._id.m - 1]}`,
      revenue: Math.round(d.revenue),
      profit: Math.round(d.revenue - d.cost),
    }));

    // ---- Top performing items ----
    const topItems = topItemsAgg.map((i) => ({
      productId: i._id,
      productName: i.productName,
      unitsSold: i.unitsSold,
      revenue: Math.round(i.revenue),
    }));

    // ---- Stuck / slow-moving items ----
    const soldQtyMap = {};
    soldQtyByProductAgg.forEach((s) => { soldQtyMap[String(s._id)] = s.unitsSold; });

    const soldQuantities = Object.values(soldQtyMap);
    const avgUnitsSold = soldQuantities.length
      ? soldQuantities.reduce((a, b) => a + b, 0) / soldQuantities.length
      : 0;
    const slowThreshold = avgUnitsSold * SLOW_MOVING_RATIO;

    const stuckItems = [];
    const slowMovingItems = [];
    productsForStockCheck.forEach((p) => {
      const sold = soldQtyMap[String(p._id)] || 0;
      const entry = {
        productId: p._id,
        productName: p.name,
        category: p.category,
        currentStock: p.currentStock,
        unitsSold: sold,
      };
      if (sold === 0) {
        stuckItems.push(entry);
      } else if (sold < slowThreshold) {
        slowMovingItems.push({ ...entry, avgUnitsSold: Math.round(avgUnitsSold * 10) / 10 });
      }
    });
    stuckItems.sort((a, b) => b.currentStock - a.currentStock);
    slowMovingItems.sort((a, b) => a.unitsSold - b.unitsSold);

    // ---- Branch performance ----
    const branchPerformance = totalBranches > 1
      ? branchPerfAgg.map((b) => ({
          branchId: b.branchId,
          branchName: b.branchName,
          revenue: Math.round(b.revenue),
          profit: Math.round(b.profit),
          receiptCount: b.receiptCount,
        }))
      : [];
    const topBranch = branchPerformance[0] || null;

    // ---- Salary payments (this range) ----
    const salary = salaryAgg[0] || { totalPaid: 0, count: 0 };
    const salaryPayments = Math.round(salary.totalPaid || 0);
    const profitAfterSalary = totalProfit - salaryPayments;

    // ---- Staff salary detail ----
    const staffSalaryDetail = staffBreakdown.map((p) => ({
      staffId: p.user?._id,
      staffName: p.user?.fullName || "Unknown",
      role: p.user?.role,
      jobTitle: p.user?.jobTitle,
      period: p.period,
      wageType: p.wageSnapshot?.wageType,
      baseEarnings: p.baseEarnings,
      extraEarnings: p.extraEarnings,
      commission: p.commission,
      leaveDeduction: p.leaveDeduction,
      taxDeductions: p.taxDeductions,
      customDeductions: p.customDeductions || [],
      customDeductionsTotal: p.customDeductionsTotal || 0,
      netPayable: p.netPayable,
      disbursedAt: p.disbursedAt,
    }));

    // ---- Next salary projection ----
    const activeWages = wageProfiles.filter((w) => w.user?.isActive);
    const estNextPayroll = Math.round(
      activeWages.reduce((sum, w) => sum + estimateMonthlyGross(w), 0)
    );
    const upcomingPayouts = activeWages
      .filter((w) => w.nextPayoutDate && !w.noSalary)
      .sort((a, b) => new Date(a.nextPayoutDate) - new Date(b.nextPayoutDate))
      .slice(0, 10)
      .map((w) => ({
        staffId: w.user._id,
        staffName: w.user.fullName,
        jobTitle: w.user.jobTitle,
        nextPayoutDate: w.nextPayoutDate,
        estimatedAmount: Math.round(estimateMonthlyGross(w)),
      }));

    const responseBody = {
      range: { preset: range, start, end },
      totals: {
        totalRevenue,
        totalProfit,
        unitsSold: totals.unitsSold || 0,
        salaryPayments,
        profitAfterSalary,
        estNextPayroll,
      },
      profitTrend,
      topItems,
      stuckItems,
      slowMovingItems,
      branchPerformance,
      topBranch,
      salary: {
        totalPaid: salaryPayments,
        payoutCount: salary.count || 0,
        upcomingPayouts,
        staffSalaryDetail,
      },
    };

    logSuccess("analytics", "Analytics overview loaded", {
      totalRevenue, totalProfit, salaryPayments, stuckCount: stuckItems.length, slowCount: slowMovingItems.length,
    });
    res.json(responseBody);
  } catch (error) {
    logError("analytics", "Error loading analytics overview", error);
    res.status(500).json({ message: "Failed to load analytics", error: error.message });
  }
};

// Shared pipeline stages: costPriceAtSale first, falls back to the
// product's *current* average remaining batch cost, then to 0 margin if
// neither is available — identical logic to revenueController.getDashboardStats
// so profit figures agree everywhere in the app.
function costEstimationStages() {
  return [
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
  ];
                  }
