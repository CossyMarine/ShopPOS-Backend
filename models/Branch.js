// models/Branch.js
import mongoose from "mongoose";

const branchSchema = new mongoose.Schema(
  {
    name:      { type: String, required: true, trim: true }, // e.g. "Westlands Branch"
    address:   { type: String, default: "" },
    taxRate:   { type: Number, default: 16 }, // region-specific VAT %, editable by Super Admin
    isActive:  { type: Boolean, default: true },
    isWarehouse: { type: Boolean, default: false },
    manager:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    tillNumber: { type: String, default: null, trim: true },
    tillName:   { type: String, default: null, trim: true },
    allowCredit: { type: Boolean, default: false }, // admin toggles credit sales per branch
    
  },
  { timestamps: true }
);

export default mongoose.model("Branch", branchSchema);
