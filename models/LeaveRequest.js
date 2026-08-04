// models/LeaveRequest.js
import mongoose from "mongoose";

const leaveRequestSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },

    type: { type: String, enum: ["paid", "unpaid"], required: true },
    from: { type: Date, required: true },
    to:   { type: Date, required: true },
    reason: { type: String, trim: true, default: null },

    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt:  { type: Date, default: null },
    decisionNote: { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("LeaveRequest", leaveRequestSchema);
