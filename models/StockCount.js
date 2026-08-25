// models/StockCount.js
import mongoose from "mongoose";

// One line per product in the count session — snapshots the system quantity
// at the moment the count STARTED, so a sale happening mid-count doesn't
// silently corrupt the variance math.
const stockCountLineSchema = new mongoose.Schema(
  {
    product:        { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName:    { type: String, required: true }, // snapshot — survives a product rename/delete
    systemQty:      { type: Number, required: true }, // stock on hand when the count was started
    countedQty:     { type: Number, default: null },  // null = not yet counted by staff
    varianceQty:    { type: Number, default: null },  // countedQty - systemQty (computed on submit)
    // Weighted avg cost/unit at the moment of reconciliation — used to price
    // the variance so costImpact reflects real money, not just units.
    unitCostAtReconcile: { type: Number, default: null },
    costImpact:     { type: Number, default: null },  // varianceQty * unitCostAtReconcile
  },
  { _id: false }
);

const stockCountSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    // Optional — count just one category (e.g. "Dairy") instead of the whole store
    category: { type: String, default: null },

    status: {
      type: String,
      enum: ["draft", "submitted", "reconciled", "cancelled"],
      default: "draft",
    },

    lines: [stockCountLineSchema],

    startedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    startedAt:  { type: Date, default: Date.now },

    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    submittedAt: { type: Date, default: null },

    reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reconciledAt: { type: Date, default: null },

    // Rolled up on reconcile, for quick display without re-summing lines
    totalVarianceQty:  { type: Number, default: 0 },
    totalCostImpact:   { type: Number, default: 0 },

    note: { type: String, default: "" },
  },
  { timestamps: true }
);

stockCountSchema.index({ branch: 1, status: 1, createdAt: -1 });

export default mongoose.model("StockCount", stockCountSchema);
