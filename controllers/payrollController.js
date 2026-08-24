// controllers/payrollController.js
import axios from "axios";
import Payslip from "../models/Payslip.js";
import WageProfile from "../models/WageProfile.js";
import Deduction from "../models/Deduction.js";
import Shift from "../models/Shift.js";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";
import { resolveEffectiveWage } from "../utils/resolveWage.js";
import { getKenyanDate, getKenyanDateFor, getKenyanDayBounds } from "../utils/dateHelpers.js";

// Literal id used in `WageProfile.selectedDeductions` / request payloads to
// refer to the built-in flat statutory levy (as opposed to an admin-created
// Deduction document).
export const STATUTORY_DEDUCTION_ID = "statutory_tax";
const STATUTORY_RATE = 0.12;
const STATUTORY_THRESHOLD = 24000;

// Rough monthly-hours/days constants used only for the "Est. Monthly
// Payroll" estimate — actual payroll runs always use real attendance/shift
// records, never these constants.
const EST_HOURS_PER_MONTH = 208; // 8 hrs * 26 working days
const EST_WEEKDAYS_PER_MONTH = 22;
const EST_WEEKENDS_PER_MONTH = 8;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash";

// "YYYY-MM" strings are timezone-unambiguous by construction, so building
// the range with Date.UTC here is safe as-is — no dateHelpers needed.
const periodToRange = (period) => {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { start, end };
};

// "YYYY-MM" for the current Kenyan calendar month — used anywhere a run/
// summary needs "this period" instead of an explicitly-picked one.
const currentPeriod = () => {
  const d = getKenyanDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const countBusinessDaysInRange = (leaves, start, end) => {
  let days = 0;
  leaves.forEach((lv) => {
    const from = new Date(Math.max(new Date(lv.from), start));
    const to = new Date(Math.min(new Date(lv.to), end));
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) days++;
  });
  return days;
};

// The "menu" of everything that can be deducted from a payslip: the one
// built-in statutory levy, plus every active custom Deduction that targets
// this user (branch-wide "all" deductions, or an "individual" one that
// names them). Used both to populate the on/off dropdown in the UI and to
// resolve what actually applies during a payroll run.
export const getAvailableDeductionsForUser = async (user) => {
  const custom = await Deduction.find({
    isActive: true,
    branch: { $in: [null, user.branch] },
    $or: [{ appliesTo: "all" }, { appliesTo: "individual", users: user._id }],
  }).sort({ name: 1 });

  return [
    {
      _id: STATUTORY_DEDUCTION_ID,
      name: "Statutory Tax (PAYE / NHIF / NSSF)",
      calcType: "percentage",
      amount: STATUTORY_RATE * 100,
      synthetic: true,
      note: `Applies automatically once gross pay exceeds ${STATUTORY_THRESHOLD.toLocaleString()} KES`,
    },
    ...custom.map((d) => ({
      _id: String(d._id),
      name: d.name,
      calcType: d.calcType,
      amount: d.amount,
      synthetic: false,
    })),
  ];
};

// Pure calculation.
// `deductions` = active custom Deduction docs already filtered to this user
//   (branch-wide "all" ones + any "individual" ones naming them).
// `selectedIds` = optional override of which deduction ids (statutory_tax
//   and/or Deduction _ids) actually get applied. null/undefined = "all
//   available" (the default — matches an empty WageProfile.selectedDeductions).
export const computeNetPay = (wage, input, deductions = [], selectedIds = undefined) => {
  if (wage.noSalary) {
    return {
      baseEarnings: 0, extraEarnings: 0, commission: 0,
      leaveDeduction: 0, taxDeductions: 0,
      customDeductions: [], customDeductionsTotal: 0,
      netPayable: 0, noSalary: true,
    };
  }

  let baseEarnings = 0, extraEarnings = 0;

  if (wage.wageType === "hourly") {
    baseEarnings = (input.hoursWorked || 0) * wage.hourlyRate;
    extraEarnings = (input.overtimeHours || 0) * (wage.hourlyRate * (wage.overtimeMultiplier || 1.5));
  } else if (wage.wageType === "daily") {
    baseEarnings = (input.weekdaysWorked || 0) * wage.dailyRateWeekday;
    extraEarnings = (input.weekendsWorked || 0) * wage.dailyRateWeekend;
  } else {
    baseEarnings = wage.monthlySalary || 0;
  }

  // Commission is a % of this person's OWN attributed sales for the period
  // (input.salesTotal — see buildPayrollInputForUser). It is 0 whenever
  // commissionRate is 0 OR the person rang up no attributable sales, which
  // in practice means it naturally stays 0 for non-cashier roles.
  const commission = wage.commissionRate
    ? +(((input.salesTotal || 0) * wage.commissionRate) / 100).toFixed(2)
    : 0;

  let leaveDeduction = 0;
  if (input.unpaidLeaveDays > 0) {
    const dailyEquivalent = wage.wageType === "monthly" ? baseEarnings / 26 : wage.dailyRateWeekday || wage.hourlyRate * 8;
    leaveDeduction = dailyEquivalent * input.unpaidLeaveDays;
  }

  const grossEarnings = baseEarnings + extraEarnings + commission - leaveDeduction;

  let taxDeductions = 0;
  let customDeductions = [];

  if (wage.applyStatutoryDeductions) {
    // Resolve the effective selection: an explicit override (bulk-run
    // param) wins, then the profile's own saved selection, then "all".
    const effectiveSelected = selectedIds !== undefined
      ? selectedIds
      : (wage.selectedDeductions && wage.selectedDeductions.length > 0 ? wage.selectedDeductions : null);
    const applyAll = !effectiveSelected || effectiveSelected.length === 0;
    const selectedSet = applyAll ? null : new Set(effectiveSelected.map(String));

    const statutoryOn = applyAll || selectedSet.has(STATUTORY_DEDUCTION_ID);
    if (statutoryOn && grossEarnings > STATUTORY_THRESHOLD) {
      taxDeductions = +(grossEarnings * STATUTORY_RATE).toFixed(2);
    }

    const applicableCustom = applyAll ? deductions : deductions.filter((d) => selectedSet.has(String(d._id)));
    customDeductions = applicableCustom.map((d) => ({
      name: d.name,
      amount: d.calcType === "percentage"
        ? +(grossEarnings * (d.amount / 100)).toFixed(2)
        : d.amount,
    }));
  }

  const customDeductionsTotal = customDeductions.reduce((sum, d) => sum + d.amount, 0);
  const netPayable = Math.max(0, grossEarnings - taxDeductions - customDeductionsTotal);

  return {
    baseEarnings, extraEarnings, commission, leaveDeduction, taxDeductions,
    customDeductions, customDeductionsTotal, netPayable, noSalary: false,
  };
};

// Gathers everything computeNetPay needs for one user + period: hours/days
// worked (from Shift for cashiers, Attendance for everyone else), unpaid
// leave days, attributed sales total (for commission), and the custom
// deductions that target them. Shared by the single-user, bulk, and staff
// detail page (preview) code paths.
export const buildPayrollInputForUser = async (user, wage, period) => {
  const { start, end } = periodToRange(period);
  let hoursWorked = 0, overtimeHours = 0, weekdaysWorked = 0, weekendsWorked = 0;

  if (user.role === "cashier") {
    const shifts = await Shift.find({ openedBy: user._id, status: "closed", createdAt: { $gte: start, $lte: end } });
    shifts.forEach((s) => {
      const hrs = (s.closedAt - s.createdAt) / 3600000;
      if (hrs > 8) { hoursWorked += 8; overtimeHours += hrs - 8; } else hoursWorked += hrs;
    });
  } else {
    // NEW — honor the branch/org "assume shift check" toggle: staff who
    // never formally clock out still get counted, using the configured
    // shift window, instead of silently losing that day's pay entirely.
    const { assumeShiftCheck, schedule } = await resolveEffectiveWage(wage);
    const records = await Attendance.find({
      user: user._id, createdAt: { $gte: start, $lte: end },
      status: assumeShiftCheck ? { $in: ["open", "closed"] } : "closed",
    });
    records.forEach((a) => {
      const day = new Date(a.createdAt).getDay();
      let clockOut = a.clockOutAt;
      if (!clockOut && assumeShiftCheck) {
        const [h, m] = (schedule.shiftEnd || "17:00").split(":").map(Number);
        clockOut = new Date(a.createdAt);
        clockOut.setHours(h, m, 0, 0);
        if (clockOut < a.createdAt) clockOut.setDate(clockOut.getDate() + 1); // overnight shift
      }
      if (!clockOut) return; // genuinely still open, enforce mode — skip
      const hrs = (clockOut - a.createdAt) / 3600000;
      if (day === 0 || day === 6) weekendsWorked += 1; else weekdaysWorked += 1;
      hoursWorked += hrs;
    });
  }

  const approvedUnpaid = await LeaveRequest.find({ user: user._id, type: "unpaid", status: "approved" });
  const unpaidLeaveDays = countBusinessDaysInRange(approvedUnpaid, start, end);

  // Real sales attributed to this person as the ringing-up cashier —
  // this is what commissionRate actually multiplies against.
  const salesOrders = await Order.find({
    cashier: user._id, status: "completed", createdAt: { $gte: start, $lte: end },
  }).select("subtotal");
  const salesTotal = salesOrders.reduce((sum, o) => sum + (o.subtotal || 0), 0);

  const deductions = wage.noSalary ? [] : await Deduction.find({
    isActive: true,
    branch: { $in: [null, user.branch] },
    $or: [{ appliesTo: "all" }, { appliesTo: "individual", users: user._id }],
  });

  return {
    input: { hoursWorked, overtimeHours, weekdaysWorked, weekendsWorked, unpaidLeaveDays, salesTotal },
    deductions,
  };
};

const upsertPayslipForUser = async (user, wage, period, req, selectedIds = undefined) => {
  const existing = await Payslip.findOne({ user: user._id, period });
  if (existing && existing.status !== "pending") {
    return { skipped: true, reason: `Payslip for ${period} is already ${existing.status}`, user };
  }

  const { input, deductions } = await buildPayrollInputForUser(user, wage, period);
  const calc = computeNetPay(wage, input, deductions, selectedIds);

  const payslip = await Payslip.findOneAndUpdate(
    { user: user._id, period },
    {
      $set: {
        branch: user.branch,
        wageSnapshot: wage.toObject(),
        ...calc,
        status: "pending",
        runBy: req.user._id,
        confirmedBy: null,
        disbursedAt: null,
      },
    },
    { new: true, upsert: true, runValidators: true }
  );

  return { skipped: false, payslip };
};

export const runPayrollForUser = async (req, res, next) => {
  const { userId, period } = req.body;
  if (!userId || !/^\d{4}-\d{2}$/.test(period || "")) {
    return res.status(400).json({ message: "userId and period ('YYYY-MM') are required" });
  }

  try {
    logStart("payroll", "Running payroll for user", { userId, period });

    const user = await User.findById(userId);
    if (!user) {
      console.warn(`[payroll] ⚠️ User not found: ${userId}`);
      return res.status(404).json({ message: "User not found" });
    }
    if (!req.user.isAdmin && String(user.branch) !== String(req.user.branch)) {
      console.warn(`[payroll] ⚠️ Branch mismatch — requester=${req.user.branch}, target=${user.branch}`);
      return res.status(403).json({ message: "You can only run payroll for your own branch" });
    }

    const wage = await WageProfile.findOne({ user: userId });
    if (!wage) {
      console.warn(`[payroll] ⚠️ No wage profile for user ${userId}`);
      return res.status(400).json({ message: "This user has no wage profile set" });
    }

    const result = await upsertPayslipForUser(user, wage, period, req);
    if (result.skipped) {
      console.warn(`[payroll] ⚠️ Skipped — ${result.reason}`);
      return res.status(400).json({ message: result.reason });
    }

    logSuccess("payroll", "Payroll run for user", {
      userId, period, payslipId: result.payslip._id, netPayable: result.payslip.netPayable,
    });
    res.status(201).json(result.payslip);
  } catch (error) {
    next(error);
  }
};

// NEW — Global / filtered payout run. Runs payroll for every staff member
// with a wage profile in scope (optionally narrowed by role and/or branch)
// for the given period in one go. `applyDeductions` + `selectedDeductionIds`
// let the admin override, for THIS RUN ONLY, which deductions get taken —
// it does not touch each person's saved wage profile settings.
export const runBulkPayroll = async (req, res, next) => {
  const { period, role, branch, applyDeductions, selectedDeductionIds } = req.body;
  if (!/^\d{4}-\d{2}$/.test(period || "")) {
    return res.status(400).json({ message: "period ('YYYY-MM') is required" });
  }

  try {
    logStart("payroll", "Running bulk payroll", { period, role: role || "all", branch: branch || "own" });

    const wageQuery = {};
    if (branch) wageQuery.branch = branch;
    else if (!req.user.isAdmin) wageQuery.branch = req.user.branch;

    let wageProfiles = await WageProfile.find(wageQuery).populate("user", "fullName role jobTitle isActive branch");
    wageProfiles = wageProfiles.filter((w) => w.user && w.user.isActive);
    if (role && role !== "all") wageProfiles = wageProfiles.filter((w) => w.user.role === role);

    // Per-run deduction override: undefined = use each profile's own
    // saved setting; [] with applyDeductions:false = skip all deductions
    // for this run; a non-empty array = restrict to just those ids.
    let selectedIdsOverride;
    if (applyDeductions === false) selectedIdsOverride = [];
    else if (Array.isArray(selectedDeductionIds) && selectedDeductionIds.length > 0) selectedIdsOverride = selectedDeductionIds;

    const results = { paid: [], skipped: [] };
    for (const wage of wageProfiles) {
      const user = wage.user;
      const wageDoc = await WageProfile.findById(wage._id); // plain doc for .toObject() snapshot
      const outcome = await upsertPayslipForUser(user, wageDoc, period, req, selectedIdsOverride);
      if (outcome.skipped) {
        results.skipped.push({ userId: user._id, fullName: user.fullName, reason: outcome.reason });
      } else {
        results.paid.push(outcome.payslip);
      }
    }

    const totalNet = results.paid.reduce((sum, p) => sum + (p.netPayable || 0), 0);

    logSuccess("payroll", "Bulk payroll run complete", {
      period, paidCount: results.paid.length, skippedCount: results.skipped.length, totalNet,
    });

    res.status(201).json({
      period,
      count: results.paid.length,
      skippedCount: results.skipped.length,
      totalNet,
      payslips: results.paid,
      skipped: results.skipped,
    });
  } catch (error) {
    next(error);
  }
};

const confirmOnePayslip = async (id, req) => {
  const slip = await Payslip.findById(id);
  if (!slip) return { skipped: true, reason: "Payslip not found" };
  if (slip.status !== "pending") return { skipped: true, reason: `Already ${slip.status}` };
  if (!req.user.isAdmin && String(slip.runBy) === String(req.user._id)) {
    return { skipped: true, reason: "A different admin/manager must confirm this payout" };
  }

  slip.status = "processing";
  slip.confirmedBy = req.user._id;
  slip.idempotencyKey = `${slip.user}-${slip.period}`;
  await slip.save();

  slip.status = "paid";
  slip.disbursedAt = getKenyanDate();
  await slip.save();

  return { skipped: false, payslip: slip };
};

export const confirmPayslip = async (req, res, next) => {
  try {
    logStart("payroll", "Confirming payslip", { payslipId: req.params.id });

    const result = await confirmOnePayslip(req.params.id, req);
    if (result.skipped) {
      console.warn(`[payroll] ⚠️ Confirm skipped — ${result.reason}`);
      return res.status(400).json({ message: result.reason });
    }

    logSuccess("payroll", "Payslip confirmed", { payslipId: result.payslip._id, netPayable: result.payslip.netPayable });
    res.json(result.payslip);
  } catch (error) {
    next(error);
  }
};

// NEW — confirm/disburse a batch of pending payslips at once (e.g. every
// payslip produced by a bulk run).
export const confirmBulkPayslips = async (req, res, next) => {
  const { payslipIds } = req.body;
  if (!Array.isArray(payslipIds) || payslipIds.length === 0) {
    return res.status(400).json({ message: "payslipIds (array) is required" });
  }

  try {
    logStart("payroll", "Confirming bulk payslips", { count: payslipIds.length });

    const confirmed = [];
    const skipped = [];
    for (const id of payslipIds) {
      const result = await confirmOnePayslip(id, req);
      if (result.skipped) skipped.push({ id, reason: result.reason });
      else confirmed.push(result.payslip);
    }
    const totalNet = confirmed.reduce((sum, p) => sum + (p.netPayable || 0), 0);

    logSuccess("payroll", "Bulk payslip confirmation complete", {
      confirmedCount: confirmed.length, skippedCount: skipped.length, totalNet,
    });

    res.json({ count: confirmed.length, skippedCount: skipped.length, totalNet, confirmed, skipped });
  } catch (error) {
    next(error);
  }
};

export const listPayslips = async (req, res, next) => {
  try {
    logStart("payroll", "Loading payslips", {
      period: req.query.period, user: req.query.user, branch: req.query.branch,
    });

    const query = {};
    if (req.query.period) query.period = req.query.period;
    if (req.query.user) query.user = req.query.user; // NEW — staff detail page history
    if (req.query.branch) query.branch = req.query.branch;
    else if (!req.user.isAdmin) query.branch = req.user.branch;

    const slips = await Payslip.find(query).populate("user", "fullName role jobTitle").sort({ createdAt: -1 });

    logSuccess("payroll", "Payslips loaded", { count: slips.length });
    res.json(slips);
  } catch (error) {
    next(error);
  }
};

export const getMyPayslips = async (req, res, next) => {
  try {
    logStart("payroll", "Loading my payslips", { user: req.user._id });
    const slips = await Payslip.find({ user: req.user._id, status: "paid" }).sort({ period: -1 });
    logSuccess("payroll", "My payslips loaded", { count: slips.length });
    res.json(slips);
  } catch (error) {
    next(error);
  }
};

// Rough gross monthly cost for one wage profile — used only for the
// "Est. Monthly Payroll" stat, never for an actual payout.
export const estimateMonthlyGross = (wage) => {
  if (!wage || wage.noSalary) return 0;
  if (wage.wageType === "monthly") return wage.monthlySalary || 0;
  if (wage.wageType === "hourly") return (wage.hourlyRate || 0) * EST_HOURS_PER_MONTH;
  if (wage.wageType === "daily") {
    return (wage.dailyRateWeekday || 0) * EST_WEEKDAYS_PER_MONTH
      + (wage.dailyRateWeekend || 0) * EST_WEEKENDS_PER_MONTH;
  }
  return 0;
};

// NEW — powers the "Est. Monthly Payroll" + "Paid This Month" stat cards,
// with the same all/role/branch scoping as the global payout panel.
export const getPayrollSummary = async (req, res, next) => {
  try {
    const { role, branch } = req.query;
    logStart("payroll", "Loading payroll summary", { role: role || "all", branch: branch || "own" });

    const wageQuery = {};
    if (branch) wageQuery.branch = branch;
    else if (!req.user.isAdmin) wageQuery.branch = req.user.branch;

    let wageProfiles = await WageProfile.find(wageQuery).populate("user", "role isActive");
    wageProfiles = wageProfiles.filter((w) => w.user && w.user.isActive);
    if (role && role !== "all") wageProfiles = wageProfiles.filter((w) => w.user.role === role);

    const estMonthlyPayroll = wageProfiles.reduce((sum, w) => sum + estimateMonthlyGross(w), 0);
    const noSalaryCount = wageProfiles.filter((w) => w.noSalary).length;

    const period = currentPeriod();
    const paidThisMonth = await Payslip.find({ period, status: "paid", ...wageQuery });
    const totalPaidThisMonth = paidThisMonth.reduce((sum, p) => sum + p.netPayable, 0);

    logSuccess("payroll", "Payroll summary loaded", {
      count: wageProfiles.length, estMonthlyPayroll: Math.round(estMonthlyPayroll), totalPaidThisMonth: Math.round(totalPaidThisMonth),
    });

    res.json({
      count: wageProfiles.length,
      noSalaryCount,
      estMonthlyPayroll: Math.round(estMonthlyPayroll),
      totalPaidThisMonth: Math.round(totalPaidThisMonth), // NEW
      payoutsThisMonth: paidThisMonth.length,               // NEW
    });
  } catch (error) {
    next(error);
  }
};

// NEW — everyone whose configured payday (or, for hourly staff, whose
// completed/assumed-complete shift) lands on today and hasn't been paid
// for the current period yet. Powers the due-for-payout banner.
export const getPayrollDueToday = async (req, res, next) => {
  try {
    logStart("payroll", "Loading payroll due today");

    const wageQuery = {};
    if (!req.user.isAdmin) wageQuery.branch = req.user.branch;

    const wageProfiles = await WageProfile.find(wageQuery)
      .populate("user", "fullName role jobTitle isActive createdAt employmentStartDate");

    const today = getKenyanDate();
    const { start: todayStart } = getKenyanDayBounds();
    const period = currentPeriod();
    const due = [];

    for (const wage of wageProfiles) {
      if (!wage.user?.isActive || wage.noSalary) continue;

      const alreadyPaid = await Payslip.findOne({ user: wage.user._id, period, status: { $in: ["paid", "processing"] } });
      if (alreadyPaid) continue;

      const effective = await resolveEffectiveWage(wage);
      let isDue = false;

      if (wage.wageType === "monthly") {
        const payDay = effective.schedule.payDay || 28;
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        isDue = today.getDate() >= Math.min(payDay, lastDay);
      } else if (wage.wageType === "daily") {
        const startRaw = wage.employmentStartDate || wage.user.employmentStartDate || wage.user.createdAt;
        const daysSinceStart = Math.floor((today - getKenyanDateFor(startRaw)) / 86400000);
        const interval = effective.schedule.intervalDays || 7;
        isDue = interval > 0 && daysSinceStart > 0 && daysSinceStart % interval === 0;
      } else if (wage.wageType === "hourly") {
        const todayShift = await Shift.findOne({ openedBy: wage.user._id, createdAt: { $gte: todayStart } });
        if (todayShift) {
          const hrs = todayShift.closedAt
            ? (todayShift.closedAt - todayShift.createdAt) / 3600000
            : effective.assumeShiftCheck ? (effective.schedule.disburseAfterHours || 10) : 0;
          isDue = hrs >= (effective.schedule.disburseAfterHours || 10);
        }
      }

      if (isDue) {
        due.push({ userId: wage.user._id, fullName: wage.user.fullName, role: wage.user.role, wageType: wage.wageType, period });
      }
    }

    logSuccess("payroll", "Payroll due today loaded", { count: due.length });
    res.json({ count: due.length, due });
  } catch (error) {
    next(error);
  }
};

// NEW — AI read on payroll health, either for one person (?userId=) or the
// whole scope (branch for managers, everything for admins).
export const getPayrollInsight = async (req, res, next) => {
  const { userId } = req.query;
  try {
    logStart("payroll", "Generating payroll insight", { userId: userId || "global" });

    let snapshot;
    if (userId) {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ message: "User not found" });

      const wage = await WageProfile.findOne({ user: userId });
      const payslips = await Payslip.find({ user: userId }).sort({ period: -1 }).limit(12);
      snapshot = {
        scope: "individual",
        name: user.fullName, role: user.role, joinedOn: user.employmentStartDate || user.createdAt,
        wageType: wage?.wageType, noSalary: wage?.noSalary,
        timesPaid: payslips.filter((p) => p.status === "paid").length,
        lastPaidOn: payslips.find((p) => p.status === "paid")?.disbursedAt || null,
        recentNet: payslips.slice(0, 6).map((p) => ({ period: p.period, net: p.netPayable, status: p.status })),
      };
    } else {
      const branchFilter = req.user.isAdmin ? {} : { branch: req.user.branch };
      const wageProfiles = await WageProfile.find(branchFilter).populate("user", "fullName isActive");
      const period = currentPeriod();
      const paidThisMonth = await Payslip.find({ period, status: "paid", ...branchFilter });
      snapshot = {
        scope: "global",
        staffCount: wageProfiles.filter((w) => w.user?.isActive).length,
        totalPaidThisMonth: paidThisMonth.reduce((s, p) => s + p.netPayable, 0),
        payoutsThisMonth: paidThisMonth.length,
        noSalaryCount: wageProfiles.filter((w) => w.noSalary).length,
      };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ message: "GEMINI_API_KEY not set" });

    const prompt = `
You are a payroll analyst for a Kenyan retail business. Given this payroll
snapshot, respond with STRICT JSON only — no markdown fences.

Snapshot: ${JSON.stringify(snapshot)}

Return: {"summary": "1-2 sentence plain-language read on whether this looks
normal or needs attention", "notes": ["short observations, max 4"]}
`.trim();

    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } },
      { timeout: 25000 }
    );
    const parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");

    logSuccess("payroll", "Payroll insight generated", { scope: snapshot.scope });
    res.json(parsed);
  } catch (error) {
    next(error);
  }
};
