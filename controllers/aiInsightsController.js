// controllers/aiInsightsController.js
import mongoose from "mongoose";
import axios from "axios";
import Product from "../models/Product.js";
import Receipt from "../models/Receipt.js";
import VoidRequest from "../models/VoidRequest.js";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import WageProfile from "../models/WageProfile.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";

// Override with GEMINI_MODEL in .env if you want a different model.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash";

const stockOf = (product) =>
  (product.batches || []).reduce((sum, b) => sum + b.quantity, 0);

// Gathers a compact snapshot of everything the AI needs to reason about —
// stock risk, void anomalies, attendance/overtime, and payroll/wage risk.
const buildStoreSnapshot = async (branchId) => {
  const branchMatch = branchId
    ? { branch: new mongoose.Types.ObjectId(branchId) }
    : {};
  const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();

  const [
    activeProducts,
    revenueTodayAgg,
    voidsPending,
    voidsToday,
    openAttendance,
    closedAttendanceToday,
    pendingLeave,
    wageProfiles,
  ] = await Promise.all([
    Product.find({ ...branchMatch, isActive: true })
      .select("name category batches reorderLevel sellingPrice packSize caseLabel casePrice")
      .lean(),

    Receipt.aggregate([
      { $match: { status: "paid", paidAt: { $gte: startOfDay, $lte: endOfDay }, ...branchMatch } },
      { $group: { _id: null, total: { $sum: "$subtotal" }, count: { $sum: 1 } } },
    ]),

    // Not branch-filtered — VoidRequest has no direct branch field, and
    // pending voids are a cross-branch admin concern anyway.
    VoidRequest.find({ status: "pending" })
      .populate("receipt", "billId")
      .select("reason voidType voidItems requestedBy createdAt receipt")
      .limit(25)
      .lean(),

    Receipt.aggregate([
      { $match: { status: "voided", updatedAt: { $gte: startOfDay, $lte: endOfDay }, ...branchMatch } },
      { $group: { _id: null, amount: { $sum: "$subtotal" }, count: { $sum: 1 } } },
    ]),

    Attendance.find({ status: "open", ...branchMatch })
      .populate("user", "fullName role jobTitle")
      .lean(),

    Attendance.find({ status: "closed", createdAt: { $gte: startOfDay, $lte: endOfDay }, ...branchMatch })
      .populate("user", "fullName role jobTitle")
      .lean(),

    LeaveRequest.find({ status: "pending", ...branchMatch })
      .populate("user", "fullName role")
      .limit(25)
      .lean(),

    WageProfile.find(branchMatch)
      .populate("user", "fullName role isActive")
      .lean(),
  ]);

  // ---- Inventory: low stock + bulk-break margin candidates ----
  const lowStockProducts = activeProducts
    .map((p) => ({ ...p, stock: stockOf(p) }))
    .filter((p) => p.stock <= p.reorderLevel)
    .map((p) => ({
      name: p.name,
      category: p.category,
      stock: p.stock,
      reorderLevel: p.reorderLevel,
      sellingPrice: p.sellingPrice,
    }));

  const bulkOpportunities = activeProducts
    .filter((p) => p.packSize > 1 && p.casePrice != null)
    .map((p) => {
      const perUnitFromCase = p.casePrice / p.packSize;
      return {
        name: p.name,
        caseLabel: p.caseLabel,
        packSize: p.packSize,
        casePrice: p.casePrice,
        sellingPricePerUnit: p.sellingPrice,
        breakEvenPerUnit: Math.round(perUnitFromCase * 100) / 100,
        marginPerUnitIfBroken: Math.round((p.sellingPrice - perUnitFromCase) * 100) / 100,
      };
    });

  // ---- Workforce: overtime beyond an 8-hour day ----
  const now = Date.now();
  const stillClockedIn = openAttendance.map((a) => {
    const hoursSoFar = (now - new Date(a.createdAt).getTime()) / 3_600_000;
    return {
      name: a.user?.fullName || "Unknown",
      role: a.user?.role,
      clockedInAt: a.createdAt,
      hoursSoFar: Math.round(hoursSoFar * 10) / 10,
      overtimeHours: Math.round(Math.max(0, hoursSoFar - 8) * 10) / 10,
    };
  });

  const completedShiftsToday = closedAttendanceToday.map((a) => {
    const hoursWorked = (new Date(a.clockOutAt).getTime() - new Date(a.createdAt).getTime()) / 3_600_000;
    return {
      name: a.user?.fullName || "Unknown",
      role: a.user?.role,
      hoursWorked: Math.round(hoursWorked * 10) / 10,
      overtimeHours: Math.round(Math.max(0, hoursWorked - 8) * 10) / 10,
    };
  });

  const totalOvertimeHours =
    [...stillClockedIn, ...completedShiftsToday].reduce((s, a) => s + a.overtimeHours, 0);

  // ---- Payroll / wage risk ----
  const upcomingPayouts = wageProfiles
    .filter((w) => w.nextPayoutDate && !w.noSalary)
    .map((w) => ({
      name: w.user?.fullName || "Unknown",
      wageType: w.wageType,
      nextPayoutDate: w.nextPayoutDate,
      paymentMethod: w.paymentMethod,
    }));

  const unpaidStaffCount = wageProfiles.filter((w) => w.noSalary).length;
  const noStatutoryDeductionsCount = wageProfiles.filter((w) => !w.applyStatutoryDeductions).length;

  const revenue = revenueTodayAgg[0] || { total: 0, count: 0 };
  const voided = voidsToday[0] || { amount: 0, count: 0 };

  return {
    store: { date: startOfDay.toISOString().split("T")[0], branchScoped: Boolean(branchId) },
    salesToday: { revenue: revenue.total, paidReceipts: revenue.count, voidedAmount: voided.amount, voidedCount: voided.count },
    lowStockProducts,
    bulkOpportunities,
    pendingVoidRequests: voidsPending.map((v) => ({
      billId: v.receipt?.billId,
      reason: v.reason,
      voidType: v.voidType,
      itemsCount: v.voidItems?.length || 0,
      requestedAt: v.createdAt,
    })),
    workforce: { stillClockedIn, completedShiftsToday, totalOvertimeHours: Math.round(totalOvertimeHours * 10) / 10 },
    pendingLeaveRequests: pendingLeave.map((l) => ({
      name: l.user?.fullName,
      type: l.type,
      from: l.from,
      to: l.to,
    })),
    payroll: { upcomingPayouts, unpaidStaffCount, noStatutoryDeductionsCount },
    metrics: {
      criticalReorders: lowStockProducts.length,
      overtimeHours: Math.round(totalOvertimeHours * 10) / 10,
      pendingVoids: voidsPending.length,
      bulkOpportunities: bulkOpportunities.length,
    },
  };
};

const callGemini = async (snapshot) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("GEMINI_API_KEY is not set on the server");
    err.status = 500;
    throw err;
  }

  const prompt = `
You are an AI retail operations analyst for Babylon POS, a Kenyan supermarket
point-of-sale platform. Analyze this store snapshot and respond with STRICT
JSON only — no markdown fences, no commentary.

Store snapshot:
${JSON.stringify(snapshot)}

Return an object with exactly these four keys, each an array of short,
actionable strings (max ~20 words each, 2-5 items per key, skip a key's
array-contents if there is genuinely nothing to flag):
- "alerts": critical stockouts, pending void/refund anomalies, anything needing urgent attention today
- "inventory": reorder priorities and bulk-to-unit margin opportunities from the data given
- "workforce": attendance/overtime observations from the clock-in data given
- "payroll": upcoming payouts, unpaid staff, or wage-profile risks from the data given

Respond with raw JSON only:
{"alerts": [], "inventory": [], "workforce": [], "payroll": []}
`.trim();

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  console.log(`[aiInsights] → Calling Gemini model "${GEMINI_MODEL}"`);
  console.log(`[aiInsights] → Endpoint: ${endpoint.replace(apiKey, "***")}`);
  console.log(`[aiInsights] → API key present: ${Boolean(apiKey)}, length: ${apiKey?.length || 0}`);
  console.log(`[aiInsights] → Prompt size: ${prompt.length} chars`);

  try {
    const { data, status } = await axios.post(
      endpoint,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      },
      { timeout: 25000 }
    );

    // ✅ This is the line to watch for a successful call — status should be 200
    console.log(`[aiInsights] ✅ Gemini responded with status ${status}`);

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      console.error("[aiInsights] ❌ Empty response body from Gemini:", JSON.stringify(data));
      throw new Error("Gemini returned an empty response");
    }

    console.log(`[aiInsights] → Raw text length: ${rawText.length} chars`);

    try {
      const parsed = JSON.parse(rawText);
      console.log("[aiInsights] ✅ Parsed insights:", JSON.stringify(parsed));
      return parsed;
    } catch (parseErr) {
      console.error("[aiInsights] ❌ Failed to parse Gemini JSON. Raw text was:", rawText);
      throw new Error(`Gemini response was not valid JSON: ${parseErr.message}`);
    }
  } catch (error) {
    if (error.response) {
      // Gemini/Google returned an actual HTTP error — this is the real reason,
      // NOT error.message, which just says "Request failed with status code X"
      console.error(
        `[aiInsights] ❌ Gemini HTTP error ${error.response.status} ${error.response.statusText}`
      );
      console.error(
        "[aiInsights] ❌ Gemini error body:",
        JSON.stringify(error.response.data, null, 2)
      );
    } else if (error.request) {
      console.error("[aiInsights] ❌ No response received from Gemini (network/timeout):", error.message);
    } else {
      console.error("[aiInsights] ❌ Error before request was sent:", error.message);
    }
    throw error;
  }
};

// @desc    Run a live AI audit across stock, voids, attendance, and payroll
// @route   GET /api/ai-insights/audit?branch=
// @access  Protected — admin, branchManager
export const runStoreAudit = async (req, res) => {
  try {
    const branchId = req.query.branch || null;
    console.log(`[aiInsights] Starting store audit${branchId ? ` for branch ${branchId}` : " (all branches)"}`);

    const snapshot = await buildStoreSnapshot(branchId);
    console.log("[aiInsights] Snapshot built. Metrics:", JSON.stringify(snapshot.metrics));

    const insights = await callGemini(snapshot);
    console.log("[aiInsights] ✅ Audit complete, sending response to client");

    res.json({
      generatedAt: new Date(),
      metrics: snapshot.metrics,
      insights,
    });
  } catch (error) {
    console.error("[aiInsights] ❌ Error running AI store audit:", error.message);
    if (error.response?.data) {
      console.error("[aiInsights] ❌ Full upstream error body:", JSON.stringify(error.response.data));
    }
    res
      .status(error.response?.status || error.status || 500)
      .json({ message: "Failed to run AI store audit", error: error.message });
  }
};
