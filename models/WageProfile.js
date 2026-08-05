// models/WageProfile.js
import mongoose from "mongoose";

const wageProfileSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },

    wageType: { type: String, enum: ["hourly", "daily", "monthly"], required: true },

    // hourly
    hourlyRate: { type: Number, default: 0 },
    overtimeMultiplier: { type: Number, default: 1.5 },

    // daily
    dailyRateWeekday: { type: Number, default: 0 },
    dailyRateWeekend: { type: Number, default: 0 },

    // monthly
    monthlySalary: { type: Number, default: 0 },
    // % of this staff member's own attributed sales (Orders where they are
    // the cashier) for the period. Only ever produces a non-zero commission
    // for staff who actually ring up sales — see payrollController.
    commissionRate: { type: Number, default: 0 },

    paymentMethod: { type: String, enum: ["mpesa", "bank", "cash"], default: "mpesa" },

    // Master switch — when false, NO deductions (statutory or custom) are
    // taken off this person's pay at all.
    applyStatutoryDeductions: { type: Boolean, default: true },

    // NEW — which deductions apply when the switch above is on.
    // Empty array = "all available deductions" (the default). Holds either
    // the literal string "statutory_tax" (the built-in PAYE/NHIF/NSSF-style
    // flat levy) or a Deduction ObjectId (as a string) for custom ones.
    selectedDeductions: { type: [String], default: [] },

    // NEW — unpaid staff (family member, attachment/intern, etc.). When true,
    // payroll always returns 0 regardless of rates set above.
    noSalary: { type: Boolean, default: false },

    // NEW — editable "next payout" date, shown/edited from the staff detail
    // page. Purely informational/schedule-tracking — running payroll does
    // not require this to be set.
    nextPayoutDate: { type: Date, default: null },

    // When true, rate fields are ignored — this person's pay comes straight
    // from the branch/org PayrollSettings default. Off = fully custom rate.
    useOrgDefaultRate: { type: Boolean, default: true },

    // null on any field = inherit that piece from PayrollSettings.
    schedule: {
      shiftStart: { type: String, default: null },
      shiftEnd: { type: String, default: null },
      disburseAfterHours: { type: Number, default: null },
      intervalDays: { type: Number, default: null },
      payDay: { type: Number, default: null },
    },

    // For daily-interval payday counting. Falls back to User.createdAt if unset.
    employmentStartDate: { type: Date, default: null },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("WageProfile", wageProfileSchema);
