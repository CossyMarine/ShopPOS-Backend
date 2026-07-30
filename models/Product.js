// models/Product.js
import mongoose from "mongoose";

// One received batch of stock — FIFO selling logic reads oldest batch first
const batchSchema = new mongoose.Schema(
  {
    quantity:     { type: Number, required: true }, // remaining in this batch
    costPerUnit:  { type: Number, required: true },
    expiryDate:   { type: Date, default: null },
    receivedAt:   { type: Date, default: Date.now },
    receivedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    supplierNote: { type: String, default: "" },
  },
  { _id: true }
);

const productSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    barcode:       { type: String, trim: true, unique: true, sparse: true }, // EAN-13/CODE128/QR payload
    category:      { type: String, default: "General", trim: true },
    unit:          { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },

    sellingPrice:  { type: Number, required: true },
    reorderLevel:  { type: Number, default: 0 },

    // Falls back to product name in the UI when null — matches your mockup
    imageUrl:      { type: String, default: null },
    imagePublicId: { type: String, default: null },

    branch:        { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    batches:       [batchSchema],

    isActive:      { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Sum of all batch quantities = current stock, always derived, never stale
productSchema.virtual("currentStock").get(function () {
  return this.batches.reduce((sum, b) => sum + b.quantity, 0);
});
productSchema.set("toJSON", { virtuals: true });
productSchema.set("toObject", { virtuals: true });

export default mongoose.model("Product", productSchema);
