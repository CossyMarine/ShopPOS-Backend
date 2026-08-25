// models/StockAdjustment.js
import mongoose from "mongoose";

const stockAdjustmentSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    branch:  { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    // Whichever shift was open for requestedBy at the moment this was filed —
    // null if no shift was open (e.g. a branchManager filing outside a till
    // shift). This is what lets shrinkage reporting group losses by shift.
    shift:   { type: mongoose.Schema.Types.ObjectId, ref: "Shift", default: null },

    quantity: { type: Number, required: true, min: 0.001 }, // in selling units (each)
    reason: {
      type: String,
      enum: ["damaged", "expired", "stolen", "spillage", "count_correction", "other"],
      required: true,
    },
    note: { type: String, default: "", trim: true },

    // Cloudinary — reuse your existing upload-image flow. Required for
    // damaged/stolen at the route-validation layer, optional for the rest.
    photoUrl:      { type: String, default: null },
    photoPublicId: { type: String, default: null },

    // Filled in only on approval, once FIFO deduction actually runs —
    // this is the monetary value of the loss, for reporting/fraud analysis.
    costImpact: { type: Number, default: null },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    rejectionNote: { type: String, default: "" },
  },
  { timestamps: true }
);

stockAdjustmentSchema.index({ branch: 1, status: 1, createdAt: -1 });
stockAdjustmentSchema.index({ product: 1, createdAt: -1 });
stockAdjustmentSchema.index({ requestedBy: 1, createdAt: -1 });
stockAdjustmentSchema.index({ shift: 1, createdAt: -1 });

export default mongoose.model("StockAdjustment", stockAdjustmentSchema);
