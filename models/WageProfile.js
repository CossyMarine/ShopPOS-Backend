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
    commissionRate: { type: Number, default: 0 }, // percent, monthly wage type only

    paymentMethod: { type: String, enum: ["mpesa", "bank", "cash"], default: "mpesa" },
    applyStatutoryDeductions: { type: Boolean, default: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("WageProfile", wageProfileSchema);
