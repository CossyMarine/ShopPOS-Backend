// models/Payslip.js
import mongoose from "mongoose";

const payslipSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    period: { type: String, required: true }, // "2026-08"

    wageSnapshot: { type: mongoose.Schema.Types.Mixed, required: true }, // frozen rates at run time

    baseEarnings:   { type: Number, required: true },
    extraEarnings:  { type: Number, default: 0 },
    commission:     { type: Number, default: 0 },
    leaveDeduction: { type: Number, default: 0 },
    taxDeductions:  { type: Number, default: 0 },
    netPayable:     { type: Number, required: true },

    status: { type: String, enum: ["pending", "processing", "paid", "failed"], default: "pending" },
    runBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    disbursedAt: { type: Date, default: null },
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

// One payslip per person per period — re-running just returns/updates the existing pending one
payslipSchema.index({ user: 1, period: 1 }, { unique: true });

export default mongoose.model("Payslip", payslipSchema);
