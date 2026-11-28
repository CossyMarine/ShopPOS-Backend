// models/GoodsReceipt.js  — one delivery (GRN)
import mongoose from "mongoose";

const lineSchema = new mongoose.Schema(
  {
    product:   { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name:      String,
    base:      String,                                   // e.g. "pc", "kg"
    bought:    [{ _id: false, name: String, qty: Number, unitQty: Number }], // 10 Box + 12 pc
    boughtText:String,
    receivedBase: Number,
    rejectedBase: Number,
    freeBase:     Number,
    addedBase:    Number,
    stockBefore:  Number,
    stockAfter:   Number,
    unitPrice:    Number,   // invoice price per base unit
    gross:        Number,
    discount:     Number,
    net:          Number,
    vatClass: { type: String, enum: ["standard", "zero", "exempt"], default: "standard" },
    exVat:    Number,       // line value before VAT, after discounts
    vat:      Number,       // VAT on this line (0 for zero-rated / exempt)
    effCost:      Number,   // real landed cost per base unit
    discounts: [{ _id: false, type: {type :String}, val: Number, unit: String, unitName: String, amount: Number }],
    expiryDate:   Date,
    batchNo:      String,
    newSellingPrice: Number,
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    no:         { type: String, required: true },
    branch:     { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    supplier:   { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    supplierName: { type: String, default: "" },
    supplierKey:  { type: String, default: "" },
    invoice:    { type: String, default: "" },
    invoiceKey: { type: String, default: "" },
    po:         { type: String, default: "" },
    supplierPin: { type: String, default: "" },   // supplier KRA PIN, copied at receiving time
    etimsNo:     { type: String, default: "" },   // supplier eTIMS / tax invoice no. (needed to claim input VAT)
    deliveryDate: { type: Date, default: Date.now },
    dueDate:    { type: Date, default: null },
    driver:     { type: String, default: "" },
    terms:      { type: String, default: "Cash on delivery" },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    receivedByName: { type: String, default: "" },
    note:       { type: String, default: "" },
    discPct: Number, discAmt: Number,
    vat: { on: Boolean, mode: String, notRecoverable: Boolean, rate: Number },
    totals: { gross: Number, lineDisc: Number, invDisc: Number, free: Number, exVat: Number, vat: Number, delivery: Number, total: Number, saved: Number },
    lines: [lineSchema],
  },
  { timestamps: true }
);

receiptSchema.index({ branch: 1, no: 1 }, { unique: true });
receiptSchema.index({ branch: 1, createdAt: -1 });
receiptSchema.index({ branch: 1, supplierKey: 1, invoiceKey: 1 });

export default mongoose.model("GoodsReceipt", receiptSchema);
