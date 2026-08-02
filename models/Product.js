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
    unit:          { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true }, // the LOOSE/each unit, e.g. Kilogram

    // How many selling units ("each") make up one purchase case/sack.
    // 1 = bought and sold loose, no case conversion (default, backwards compatible).
    // e.g. a 50kg sack of sugar with unit=Kilogram → packSize: 50
    packSize:      { type: Number, default: 1, min: 1 },
    // Display label for the purchase unit when packSize > 1, e.g. "Sack", "Carton", "Crate"
    caseLabel:     { type: String, default: "Carton", trim: true },
    // Optional separate barcode printed on the case itself, distinct from the each barcode
    caseBarcode:   { type: String, trim: true, default: null },

    // Price per loose/each unit — e.g. KES 180 per kg. Always required.
    sellingPrice:  { type: Number, required: true },
    // Price for the WHOLE case/sack sold intact — e.g. KES 6,000 for the sack.
    // Independent of sellingPrice × packSize on purpose: bulk pricing is
    // rarely a straight multiple (that's the whole point of buying in bulk).
    // Only meaningful when packSize > 1; null otherwise.
    casePrice:     { type: Number, default: null },

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

// Sum of all batch quantities = current stock, always derived, never stale.
// Guarded because queries that .select() a subset of fields (e.g. the public
// catalog) omit `batches` entirely — this.batches is undefined there, and
// toJSON:{virtuals:true} means this getter still runs on every res.json().
productSchema.virtual("currentStock").get(function () {
  return (this.batches || []).reduce((sum, b) => sum + b.quantity, 0);
});
productSchema.set("toJSON", { virtuals: true });
productSchema.set("toObject", { virtuals: true });

export default mongoose.model("Product", productSchema);
