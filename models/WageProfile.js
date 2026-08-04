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
    commissionRate: { type: Number, default: 0 },

    paymentMethod: { type: String, enum: ["mpesa", "bank", "cash"], default: "mpesa" },
    applyStatutoryDeductions: { type: Boolean, default: true },

    // NEW — unpaid staff (family member, attachment/intern, etc.). When true,
    // payroll always returns 0 regardless of rates set above.
    noSalary: { type: Boolean, default: false },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("WageProfile", wageProfileSchema);
