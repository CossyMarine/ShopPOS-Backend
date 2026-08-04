// controllers/payrollController.js
import Payslip from "../models/Payslip.js";
import WageProfile from "../models/WageProfile.js";
import Deduction from "../models/Deduction.js";
import Shift from "../models/Shift.js";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import User from "../models/User.js";

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

// Pure calculation. `deductions` = already-filtered active Deduction docs
// (all-staff + individual ones targeting this user).
export const computeNetPay = (wage, input, deductions = []) => {
  if (wage.noSalary) {
    return {
      baseEarnings: 0, extraEarnings: 0, commission: 0,
      leaveDeduction: 0, taxDeductions: 0,
      customDeductions: [], customDeductionsTotal: 0,
      netPayable: 0, noSalary: true,
    };
  }

  let baseEarnings = 0, extraEarnings = 0;
  const commission = input.commission || 0;

  if (wage.wageType === "hourly") {
    baseEarnings = (input.hoursWorked || 0) * wage.hourlyRate;
    extraEarnings = (input.overtimeHours || 0) * (wage.hourlyRate * (wage.overtimeMultiplier || 1.5));
  } else if (wage.wageType === "daily") {
    baseEarnings = (input.weekdaysWorked || 0) * wage.dailyRateWeekday;
    extraEarnings = (input.weekendsWorked || 0) * wage.dailyRateWeekend;
  } else {
    baseEarnings = wage.monthlySalary || 0;
  }

  let leaveDeduction = 0;
  if (input.unpaidLeaveDays > 0) {
    const dailyEquivalent = wage.wageType === "monthly" ? baseEarnings / 26 : wage.dailyRateWeekday || wage.hourlyRate * 8;
    leaveDeduction = dailyEquivalent * input.unpaidLeaveDays;
  }

  const grossEarnings = baseEarnings + extraEarnings + commission - leaveDeduction;

  let taxDeductions = 0;
  if (wage.applyStatutoryDeductions && grossEarnings > 24000) {
    taxDeductions = grossEarnings * 0.12;
  }

  const customDeductions = deductions.map((d) => ({
    name: d.name,
    amount: d.calcType === "percentage"
      ? +(grossEarnings * (d.amount / 100)).toFixed(2)
      : d.amount,
  }));
  const customDeductionsTotal = customDeductions.reduce((sum, d) => sum + d.amount, 0);

  const netPayable = Math.max(0, grossEarnings - taxDeductions - customDeductionsTotal);

  return {
    baseEarnings, extraEarnings, commission, leaveDeduction, taxDeductions,
    customDeductions, customDeductionsTotal, netPayable, noSalary: false,
  };
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

    const existing = await Payslip.findOne({ user: userId, period });
    if (existing && existing.status !== "pending") {
      return res.status(400).json({ message: `Payslip for ${period} is already ${existing.status}` });
    }

    const { start, end } = periodToRange(period);
    let hoursWorked = 0, overtimeHours = 0, weekdaysWorked = 0, weekendsWorked = 0;

    if (user.role === "cashier") {
      const shifts = await Shift.find({ openedBy: userId, status: "closed", createdAt: { $gte: start, $lte: end } });
      shifts.forEach((s) => {
        const hrs = (s.closedAt - s.createdAt) / 3600000;
        if (hrs > 8) { hoursWorked += 8; overtimeHours += hrs - 8; } else hoursWorked += hrs;
      });
    } else {
      const records = await Attendance.find({ user: userId, status: "closed", createdAt: { $gte: start, $lte: end } });
      records.forEach((a) => {
        const day = new Date(a.createdAt).getDay();
        const hrs = (a.clockOutAt - a.createdAt) / 3600000;
        if (day === 0 || day === 6) weekendsWorked += 1; else weekdaysWorked += 1;
        hoursWorked += hrs;
      });
    }

    const approvedUnpaid = await LeaveRequest.find({ user: userId, type: "unpaid", status: "approved" });
    const unpaidLeaveDays = countBusinessDaysInRange(approvedUnpaid, start, end);

    const commission = wage.wageType === "monthly" && wage.commissionRate ? 0 : 0;

    // NEW — active deductions that apply to everyone, or specifically to this user
    const deductions = wage.noSalary ? [] : await Deduction.find({
      isActive: true,
      branch: { $in: [null, user.branch] },
      $or: [{ appliesTo: "all" }, { appliesTo: "individual", users: userId }],
    });

    const calc = computeNetPay(
      wage,
      { hoursWorked, overtimeHours, weekdaysWorked, weekendsWorked, unpaidLeaveDays, commission },
      deductions
    );

    const payslip = await Payslip.findOneAndUpdate(
      { user: userId, period },
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

    res.status(201).json(payslip);
  } catch (error) {
    console.error("Error running payroll:", error.message);
    res.status(500).json({ message: "Failed to run payroll", error: error.message });
  }
};

export const confirmPayslip = async (req, res) => {
  try {
    const slip = await Payslip.findById(req.params.id);
    if (!slip) return res.status(404).json({ message: "Payslip not found" });
    if (slip.status !== "pending") {
      return res.status(400).json({ message: `Already ${slip.status}` });
    }
    if (!req.user.isAdmin && String(slip.runBy) === String(req.user._id)) {
      return res.status(403).json({ message: "A different admin/manager must confirm this payout" });
    }

    slip.status = "processing";
    slip.confirmedBy = req.user._id;
    slip.idempotencyKey = `${slip.user}-${slip.period}`;
    await slip.save();

    slip.status = "paid";
    slip.disbursedAt = new Date();
    await slip.save();

    res.json(slip);
  } catch (error) {
    console.error("Error confirming payslip:", error.message);
    res.status(500).json({ message: "Failed to confirm payslip", error: error.message });
  }
};

export const listPayslips = async (req, res) => {
  try {
    const query = {};
    if (req.query.period) query.period = req.query.period;
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
