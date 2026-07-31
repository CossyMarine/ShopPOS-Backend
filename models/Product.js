// models/Product.js
import mongoose from "mongoose";

// One received batch of stock — FIFO selling logic reads oldest batch first.
// quantity/costPerUnit are ALWAYS in selling-unit ("each") terms, even when
// the batch was received as cases — receivedAsCases/costPerCase are kept
// alongside purely as an audit trail of what was actually typed in.
const batchSchema = new mongoose.Schema(
  {
    quantity:        { type: Number, required: true }, // remaining, in selling units (each)
    costPerUnit:     { type: Number, required: true }, // cost per selling unit (each)
    receivedAsCases: { type: Number, default: null },  // set only if received by the case
    costPerCase:     { type: Number, default: null },  // cost per case as entered, for display
    expiryDate:      { type: Date, default: null },
    receivedAt:      { type: Date, default: Date.now },
    receivedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    supplierNote:    { type: String, default: "" },
  },
  { _id: true }
);

const productSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    barcode:       { type: String, trim: true, unique: true, sparse: true }, // EAN-13/CODE128/QR payload — the EACH barcode
    category:      { type: String, default: "General", trim: true },
    unit:          { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },

    // How many selling units ("each") make up one purchase case/carton.
    // 1 = bought and sold loose, no case conversion (default, backwards compatible).
    packSize:      { type: Number, default: 1, min: 1 },
    // Display label for the purchase unit when packSize > 1, e.g. "Carton", "Box", "Crate"
    caseLabel:     { type: String, default: "Carton", trim: true },
    // Optional separate barcode printed on the case itself, distinct from the each barcode
    caseBarcode:   { type: String, trim: true, default: null },

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
