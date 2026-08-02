// models/VoidRequest.js
import mongoose from "mongoose";

// Snapshot of one voided line item — captured at request time so the audit
// trail survives even if the receipt's items array changes before approval.
const voidItemSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true }, // position in receipt.items when requested
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
  },
  { _id: false }
);

const voidRequestSchema = new mongoose.Schema(
  {
    receipt: { type: mongoose.Schema.Types.ObjectId, ref: "Receipt", required: true },
    reason: { type: String, required: true },

    // "full" voids the whole receipt (legacy/default behaviour). "partial"
    // only voids the specific line items captured in voidItems.
    voidType: { type: String, enum: ["full", "partial"], default: "full" },
    voidItems: { type: [voidItemSchema], default: [] },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("VoidRequest", voidRequestSchema);
