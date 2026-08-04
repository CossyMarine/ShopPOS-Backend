// models/Deduction.js
import mongoose from "mongoose";

const deductionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // e.g. "NHIF"
    calcType: { type: String, enum: ["fixed", "percentage"], required: true, default: "fixed" },
    amount: { type: Number, required: true, default: 0 }, // KES if fixed, % of gross if percentage

    appliesTo: { type: String, enum: ["all", "individual"], required: true, default: "all" },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], // only used when appliesTo === "individual"

    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null }, // null = applies branch-wide (admin-created)
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default mongoose.model("Deduction", deductionSchema);
