// models/StockTransfer.js
import mongoose from "mongoose";

const transferLineSchema = new mongoose.Schema(
  {
    product:     { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true }, // source branch's product doc
    productName: { type: String, required: true },
    barcode:     { type: String, default: null }, // snapshot — used to match/create the product at destination

    quantitySent:    { type: Number, required: true },
    // Weighted-average cost/unit at the moment of dispatch — this is what
    // travels with the stock, so the receiving branch's batch is valued
    // at true cost, not invented.
    unitCostAtSend:  { type: Number, default: null },

    quantityReceived: { type: Number, default: null }, // null = not yet received
    // The Product doc at the DESTINATION branch this line landed on —
    // set on receive, whether matched to an existing product or newly created.
    destinationProduct: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },

    discrepancyNote: { type: String, default: "" }, // e.g. "2 units damaged in transit"
  },
  { _id: false }
);

const stockTransferSchema = new mongoose.Schema(
  {
    fromBranch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    toBranch:   { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },

    status: {
      type: String,
      // draft: planned, stock still fully at fromBranch, nothing deducted yet
      // in_transit: dispatched — deducted from fromBranch, not yet on toBranch's shelf
      // completed: received at toBranch (fully or partially, see per-line quantityReceived)
      // cancelled: abandoned — if it was in_transit, stock was restocked back to fromBranch
      enum: ["draft", "in_transit", "completed", "cancelled"],
      default: "draft",
    },

    lines: [transferLineSchema],

    initiatedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dispatchedAt: { type: Date, default: null },
    receivedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    receivedAt:   { type: Date, default: null },

    note: { type: String, default: "" },
  },
  { timestamps: true }
);

stockTransferSchema.index({ fromBranch: 1, status: 1, createdAt: -1 });
stockTransferSchema.index({ toBranch: 1, status: 1, createdAt: -1 });

export default mongoose.model("StockTransfer", stockTransferSchema);
