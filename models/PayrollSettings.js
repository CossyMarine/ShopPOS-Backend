// models/PayrollSettings.js
import mongoose from "mongoose";

const payrollSettingsSchema = new mongoose.Schema(
  {
    // null = global default. A branch-specific doc overrides it for that branch.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, unique: true, sparse: true },

    wageType: { type: String, enum: ["hourly", "daily", "monthly"], required: true },
    hourlyRate: { type: Number, default: 0 },
    overtimeMultiplier: { type: Number, default: 1.5 },
    dailyRateWeekday: { type: Number, default: 0 },
    dailyRateWeekend: { type: Number, default: 0 },
    monthlySalary: { type: Number, default: 0 },
    commissionRate: { type: Number, default: 0 },

    paymentMethod: { type: String, enum: ["mpesa", "bank", "cash"], default: "mpesa" },
    applyStatutoryDeductions: { type: Boolean, default: true },
    selectedDeductions: { type: [String], default: [] },

    schedule: {
      shiftStart: { type: String, default: "08:00" },      // hourly
      shiftEnd: { type: String, default: "17:00" },          // hourly
      disburseAfterHours: { type: Number, default: 10 },     // hourly — shift counted "payable"
      intervalDays: { type: Number, default: 7 },             // daily — pay every N days from start date
      payDay: { type: Number, default: 28 },                  // monthly — calendar day (1-31)
    },

    // Default true — most Kenyan staff don't formally clock out, so an
    // open shift past shiftEnd is assumed complete for payroll purposes.
    assumeShiftCheck: { type: Boolean, default: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("PayrollSettings", payrollSettingsSchema);
