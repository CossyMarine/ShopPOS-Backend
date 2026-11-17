// models/Supplier.js
import mongoose from "mongoose";

const supplierSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    nameKey:       { type: String, index: true },
    contactPerson: { type: String, trim: true, default: "" },
    phone:         { type: String, trim: true, default: "" },
    email:         { type: String, trim: true, lowercase: true, default: "" },
    address:       { type: String, trim: true, default: "" },
    kraPin:        { type: String, trim: true, default: "" },
    paymentTerms:  { type: String, default: "Cash on delivery" },
    note:          { type: String, trim: true, default: "" },
    branch:        { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    isActive:      { type: Boolean, default: true },
  },
  { timestamps: true }
);

supplierSchema.pre("validate", function (next) {
  this.nameKey = (this.name || "").trim().toLowerCase();
  next();
});
supplierSchema.index({ branch: 1, nameKey: 1 }, { unique: true });

export default mongoose.model("Supplier", supplierSchema);
