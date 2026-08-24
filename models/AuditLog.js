// models/AuditLog.js
import mongoose from "mongoose";

// Append-only audit trail. Nothing that writes here should ever be updated
// or deleted — that's the whole point. Covers stock adjustments now, but
// entityType is generic so other sensitive actions (void approvals, price
// changes, etc.) can log here too later.
const auditLogSchema = new mongoose.Schema(
  {
    entityType: { type: String, required: true }, // e.g. "StockAdjustment"
    entityId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    action:     { type: String, required: true }, // "created" | "approved" | "rejected"
    performedBy:{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    branch:     { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },

    // Free-form snapshot of what happened — quantities, reason, cost impact,
    // whatever the caller wants preserved exactly as it was at that moment.
    details:    { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ branch: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });

export default mongoose.model("AuditLog", auditLogSchema);
