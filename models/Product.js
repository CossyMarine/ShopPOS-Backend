// models/Product.js
import mongoose from "mongoose";

const batchSchema = new mongoose.Schema(
  {
    quantity:        { type: Number, required: true },
    costPerUnit:     { type: Number, required: true },
    receivedAsCases: { type: Number, default: null },
    costPerCase:     { type: Number, default: null },
    expiryDate:      { type: Date, default: null },
    receivedAt:      { type: Date, default: Date.now },
    receivedBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    supplierNote:    { type: String, default: "" },
    // NEW: delivery link + what was actually bought (e.g. 10 Box + 12 pcs)
    batchNo:         { type: String, default: "" },
    receipt:         { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceipt", default: null },
    boughtAs: [{ _id: false, name: String, qty: Number, unitQty: Number }],
  },
  { _id: true }
);

// A pack = Box, Carton, Sack... qty = how many base units inside.
const packSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    qty:     { type: Number, required: true, min: 2 },
    barcode: { type: String, trim: true, default: null },
    price:   { type: Number, default: null, min: 0 }, // selling price per whole pack, null = auto
    imageUrl:      { type: String, default: null },   //  pack photo (falls back to product photo)
    imagePublicId: { type: String, default: null },
  },
  { _id: true }
);

// A portion = a way to sell LESS than one base unit (½ kg, ¼ kg, half bar...).
// qty = how much of the base unit ONE portion uses (e.g. 0.25 for ¼ kg).
// Stock is still held in base units; a portion sale just deducts qty from it.
const portionSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    qty:     { type: Number, required: true, min: 0.001 },
    price:   { type: Number, required: true, min: 0 },   // selling price per ONE portion
    barcode: { type: String, trim: true, default: null },
  },
  { _id: true }
);

const productSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    barcode:     { type: String, trim: true },
    category:    { type: String, default: "General", trim: true },
    vatClass:    { type: String, enum: ["standard", "zero", "exempt"], default: "standard" },
    unit:        { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },

    // NEW
    packs:        [packSchema],
    portions:     { type: [portionSchema], default: [] }, // empty = a normal product
    sku:          { type: String, trim: true, default: "" },
    description:  { type: String, trim: true, default: "" },
    maxLevel:     { type: Number, default: 0 },
    reorderQty:   { type: Number, default: 0 },
    perishable:   { type: Boolean, default: false },
    allowDecimals:{ type: Boolean, default: null }, // null = guess from unit (kg, l...)
    supplier:     { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },

    // LEGACY (kept in sync from the largest pack so cashier/transfers keep working)
    packSize:    { type: Number, default: 1, min: 1 },
    caseLabel:   { type: String, default: "Carton", trim: true },
    caseBarcode: { type: String, trim: true, default: null },
    casePrice:   { type: Number, default: null },

    sellingPrice: { type: Number, required: true },
    reorderLevel: { type: Number, default: 0 },
    imageUrl:      { type: String, default: null },
    imagePublicId: { type: String, default: null },
    branch:  { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    batches: [batchSchema],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ branch: 1, barcode: 1 }, { unique: true, sparse: true });
productSchema.index({ branch: 1, caseBarcode: 1 }, { unique: true, sparse: true });
// Lookup speed only. Uniqueness of portion barcodes is enforced in productController's checkCodes
// (a unique index here would clash on the many portions that have no barcode).
productSchema.index({ branch: 1, "portions.barcode": 1 });

// Products created through the old fields (e.g. by stock transfers) get a pack automatically.
productSchema.pre("validate", function (next) {
  if ((!this.packs || this.packs.length === 0) && this.packSize > 1) {
    this.packs.push({
      name: this.caseLabel || "Carton",
      qty: this.packSize,
      barcode: this.caseBarcode || null,
      price: this.casePrice ?? null,
    });
  }
  next();
});

productSchema.virtual("currentStock").get(function () {
  return (this.batches || []).reduce((sum, b) => sum + b.quantity, 0);
});
productSchema.set("toJSON", { virtuals: true });
productSchema.set("toObject", { virtuals: true });

export default mongoose.model("Product", productSchema);
