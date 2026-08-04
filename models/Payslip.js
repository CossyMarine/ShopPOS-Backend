// models/Payslip.js
import mongoose from "mongoose";

const payslipSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    period: { type: String, required: true },

    wageSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },

    baseEarnings:   { type: Number, required: true },
    extraEarnings:  { type: Number, default: 0 },
    commission:     { type: Number, default: 0 },
    leaveDeduction: { type: Number, default: 0 },
    taxDeductions:  { type: Number, default: 0 },

    // NEW
    customDeductions:      [{ name: String, amount: Number }],
    customDeductionsTotal: { type: Number, default: 0 },
    noSalary:               { type: Boolean, default: false },

    netPayable: { type: Number, required: true },

    status: { type: String, enum: ["pending", "processing", "paid", "failed"], default: "pending" },
    runBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    disbursedAt: { type: Date, default: null },
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

payslipSchema.index({ user: 1, period: 1 }, { unique: true });

export default mongoose.model("Payslip", payslipSchema);
