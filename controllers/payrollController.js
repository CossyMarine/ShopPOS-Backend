// controllers/payrollController.js
import Payslip from "../models/Payslip.js";
import WageProfile from "../models/WageProfile.js";
import Deduction from "../models/Deduction.js";
import Shift from "../models/Shift.js";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Order from "../models/Order.js";
import User from "../models/User.js";

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

const periodToRange = (period) => {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { start, end };
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
    const records = await Attendance.find({ user: user._id, status: "closed", createdAt: { $gte: start, $lte: end } });
    records.forEach((a) => {
      const day = new Date(a.createdAt).getDay();
      const hrs = (a.clockOutAt - a.createdAt) / 3600000;
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

export const runPayrollForUser = async (req, res) => {
  const { userId, period } = req.body;
  if (!userId || !/^\d{4}-\d{2}$/.test(period || "")) {
    return res.status(400).json({ message: "userId and period ('YYYY-MM') are required" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!req.user.isAdmin && String(user.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: "You can only run payroll for your own branch" });
    }

    const wage = await WageProfile.findOne({ user: userId });
    if (!wage) return res.status(400).json({ message: "This user has no wage profile set" });

    const result = await upsertPayslipForUser(user, wage, period, req);
    if (result.skipped) return res.status(400).json({ message: result.reason });

    res.status(201).json(result.payslip);
  } catch (error) {
    console.error("Error running payroll:", error.message);
    res.status(500).json({ message: "Failed to run payroll", error: error.message });
  }
};

// NEW — Global / filtered payout run. Runs payroll for every staff member
// with a wage profile in scope (optionally narrowed by role and/or branch)
// for the given period in one go. `applyDeductions` + `selectedDeductionIds`
// let the admin override, for THIS RUN ONLY, which deductions get taken —
// it does not touch each person's saved wage profile settings.
export const runBulkPayroll = async (req, res) => {
  const { period, role, branch, applyDeductions, selectedDeductionIds } = req.body;
  if (!/^\d{4}-\d{2}$/.test(period || "")) {
    return res.status(400).json({ message: "period ('YYYY-MM') is required" });
  }

  try {
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
    res.status(201).json({
      period,
      count: results.paid.length,
      skippedCount: results.skipped.length,
      totalNet,
      payslips: results.paid,
      skipped: results.skipped,
    });
  } catch (error) {
    console.error("Error running bulk payroll:", error.message);
    res.status(500).json({ message: "Failed to run bulk payroll", error: error.message });
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
  slip.disbursedAt = new Date();
  await slip.save();

  return { skipped: false, payslip: slip };
};

export const confirmPayslip = async (req, res) => {
  try {
    const result = await confirmOnePayslip(req.params.id, req);
    if (result.skipped) return res.status(400).json({ message: result.reason });
    res.json(result.payslip);
  } catch (error) {
    console.error("Error confirming payslip:", error.message);
    res.status(500).json({ message: "Failed to confirm payslip", error: error.message });
  }
};

// NEW — confirm/disburse a batch of pending payslips at once (e.g. every
// payslip produced by a bulk run).
export const confirmBulkPayslips = async (req, res) => {
  const { payslipIds } = req.body;
  if (!Array.isArray(payslipIds) || payslipIds.length === 0) {
    return res.status(400).json({ message: "payslipIds (array) is required" });
  }

  try {
    const confirmed = [];
    const skipped = [];
    for (const id of payslipIds) {
      const result = await confirmOnePayslip(id, req);
      if (result.skipped) skipped.push({ id, reason: result.reason });
      else confirmed.push(result.payslip);
    }
    const totalNet = confirmed.reduce((sum, p) => sum + (p.netPayable || 0), 0);
    res.json({ count: confirmed.length, skippedCount: skipped.length, totalNet, confirmed, skipped });
  } catch (error) {
    console.error("Error confirming bulk payslips:", error.message);
    res.status(500).json({ message: "Failed to confirm payouts", error: error.message });
  }
};

export const listPayslips = async (req, res) => {
  try {
    const query = {};
    if (req.query.period) query.period = req.query.period;
    if (req.query.user) query.user = req.query.user; // NEW — staff detail page history
    if (req.query.branch) query.branch = req.query.branch;
    else if (!req.user.isAdmin) query.branch = req.user.branch;

    const slips = await Payslip.find(query).populate("user", "fullName role jobTitle").sort({ createdAt: -1 });
    res.json(slips);
  } catch (error) {
    res.status(500).json({ message: "Failed to load payslips", error: error.message });
  }
};

export const getMyPayslips = async (req, res) => {
  try {
    const slips = await Payslip.find({ user: req.user._id, status: "paid" }).sort({ period: -1 });
    res.json(slips);
  } catch (error) {
    res.status(500).json({ message: "Failed to load payslips", error: error.message });
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

// NEW — powers the "Est. Monthly Payroll" stat card, with the same
// all/role/branch scoping as the global payout panel.
export const getPayrollSummary = async (req, res) => {
  try {
    const { role, branch } = req.query;
    const wageQuery = {};
    if (branch) wageQuery.branch = branch;
    else if (!req.user.isAdmin) wageQuery.branch = req.user.branch;

    let wageProfiles = await WageProfile.find(wageQuery).populate("user", "role isActive");
    wageProfiles = wageProfiles.filter((w) => w.user && w.user.isActive);
    if (role && role !== "all") wageProfiles = wageProfiles.filter((w) => w.user.role === role);

    const estMonthlyPayroll = wageProfiles.reduce((sum, w) => sum + estimateMonthlyGross(w), 0);
    const noSalaryCount = wageProfiles.filter((w) => w.noSalary).length;

    res.json({
      count: wageProfiles.length,
      noSalaryCount,
      estMonthlyPayroll: Math.round(estMonthlyPayroll),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load payroll summary", error: error.message });
  }
};
