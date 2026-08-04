// controllers/staffController.js
import User from "../models/User.js";
import WageProfile from "../models/WageProfile.js";
import Shift from "../models/Shift.js";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Payslip from "../models/Payslip.js";
import {
  getAvailableDeductionsForUser,
  buildPayrollInputForUser,
  computeNetPay,
  estimateMonthlyGross,
} from "./payrollController.js";

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Everything the "tap staff -> open a page" detail view needs in one call:
// profile, wage setup, recent work history (shifts for cashiers, attendance
// for everyone else), leave, full payslip history, a preview of what the
// current/next payslip would look like, and the deduction menu for editing.
export const getStaffOverview = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).populate("branch", "name");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!req.user.isAdmin && String(user.branch?._id || user.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: "You can only view staff in your own branch" });
    }

    const wage = await WageProfile.findOne({ user: userId });

    // Work history — last 20 shifts (cashiers) or attendance records
    // (everyone else), newest first.
    let workHistory = [];
    if (user.role === "cashier") {
      const shifts = await Shift.find({ openedBy: userId }).sort({ createdAt: -1 }).limit(20);
      workHistory = shifts.map((s) => ({
        type: "shift",
        date: s.createdAt,
        clockIn: s.createdAt,
        clockOut: s.closedAt,
        status: s.status,
        hours: s.closedAt ? +(((s.closedAt - s.createdAt) / 3600000).toFixed(2)) : null,
        openingFloat: s.openingFloat,
        closingCashCount: s.closingCashCount,
      }));
    } else {
      const records = await Attendance.find({ user: userId }).sort({ createdAt: -1 }).limit(20);
      workHistory = records.map((a) => ({
        type: "attendance",
        date: a.createdAt,
        clockIn: a.createdAt,
        clockOut: a.clockOutAt,
        status: a.status,
        hours: a.clockOutAt ? +(((a.clockOutAt - a.createdAt) / 3600000).toFixed(2)) : null,
        notes: a.notes,
      }));
    }

    const leaveHistory = await LeaveRequest.find({ user: userId }).sort({ createdAt: -1 }).limit(10);

    const payslipHistory = await Payslip.find({ user: userId }).sort({ period: -1 });

    // Preview of the current period's payslip using live data — informational
    // only, nothing is saved. Lets the detail page show "what they've earned
    // so far this period" even before an admin runs payroll.
    let currentPeriodPreview = null;
    if (wage) {
      const period = currentPeriod();
      const { input, deductions } = await buildPayrollInputForUser(user, wage, period);
      currentPeriodPreview = { period, ...computeNetPay(wage, input, deductions) };
    }

    const deductionOptions = await getAvailableDeductionsForUser(user);

    res.json({
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        jobTitle: user.jobTitle,
        isActive: user.isActive,
        branch: user.branch,
        isAdmin: user.isAdmin,
        createdAt: user.createdAt,
      },
      wageProfile: wage,
      estMonthlyGross: wage ? estimateMonthlyGross(wage) : 0,
      workHistory,
      leaveHistory,
      payslipHistory,
      currentPeriodPreview,
      deductionOptions,
    });
  } catch (error) {
    console.error("Error loading staff overview:", error.message);
    res.status(500).json({ message: "Failed to load staff overview", error: error.message });
  }
};
