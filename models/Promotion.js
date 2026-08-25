// models/Promotion.js
import mongoose from "mongoose";

// A promotion is either scoped to specific products or to a whole category —
// never both, enforced at the controller level, not here (Mongoose
// conditional-required across two fields is more trouble than it's worth).
const promotionSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true }, // e.g. "August Soap Sale"
    type:        { type: String, enum: ["percent_off", "flat_off"], required: true },
    // percent_off: 0–100. flat_off: currency amount deducted per unit sold —
    // always in the branch's currency, never a total-order amount.
    value:       { type: Number, required: true, min: 0 },

    scope:       { type: String, enum: ["product", "category"], required: true },
    products:    [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }], // when scope = "product"
    category:    { type: String, default: null, trim: true },               // when scope = "category"

    // null = applies across every branch. Set to a specific branch id to
    // scope it to just that store — per-branch promo scoping is supported
    // by the schema even though the current UI only drives store-wide promos.
    branch:      { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },

    startDate:   { type: Date, required: true },
    endDate:     { type: Date, required: true },
    // Independent kill switch — lets staff pause a promo mid-window without
    // deleting it or fiddling with its dates.
    isActive:    { type: Boolean, default: true },

    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    notes:       { type: String, default: "" },
  },
  { timestamps: true }
);

promotionSchema.index({ branch: 1, isActive: 1, startDate: 1, endDate: 1 });
promotionSchema.index({ products: 1 });
promotionSchema.index({ category: 1 });

// True only if the promo is switched on AND `at` falls inside its window.
promotionSchema.methods.isLiveAt = function (at = new Date()) {
  return this.isActive && this.startDate <= at && this.endDate >= at;
};

export default mongoose.model("Promotion", promotionSchema);
