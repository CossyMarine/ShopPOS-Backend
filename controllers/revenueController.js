// controllers/revenueController.js
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";

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
