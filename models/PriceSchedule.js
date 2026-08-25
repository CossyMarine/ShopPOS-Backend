// models/PriceSchedule.js
import mongoose from "mongoose";

// A scheduled change to a single price field on a single product. Kept as
// its own collection (rather than an array on Product) so the audit trail
// survives even if the product is later deleted, and so "what's coming up"
// can be queried across the whole branch in one shot for a pricing calendar.
const priceScheduleSchema = new mongoose.Schema(
  {
    product:     { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    branch:      { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true }, // denormalized from product, for fast branch-wide queries
    field:       { type: String, enum: ["sellingPrice", "casePrice"], default: "sellingPrice" },

    // The price this was AT THE MOMENT IT WAS SCHEDULED — a snapshot for
    // display ("changing from X to Y"), not necessarily what's live right
    // before it applies if something else changed the price in between.
    // `previousValueAtApply` below captures the value that was actually
    // overwritten, which is what the audit trail should be trusted on.
    valueAtScheduling: { type: Number, required: true },
    newValue:    { type: Number, required: true },

    effectiveAt: { type: Date, required: true },
    status:      { type: String, enum: ["pending", "applied", "cancelled"], default: "pending" },

    scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    appliedAt:   { type: Date, default: null },
    previousValueAtApply: { type: Number, default: null }, // the real "old" value, captured at the instant this actually applied

    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

priceScheduleSchema.index({ status: 1, effectiveAt: 1 });
priceScheduleSchema.index({ product: 1, status: 1 });
priceScheduleSchema.index({ branch: 1, status: 1 });

export default mongoose.model("PriceSchedule", priceScheduleSchema);
