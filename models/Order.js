// models/Order.js
import mongoose from "mongoose";

// orderItemSchema — rename menuItemId/mealName to product terms:
const orderItemSchema = new mongoose.Schema(
  {
    productId:  { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    productName: { type: String, required: true },
    imageUrl:   { type: String, default: null },
    quantity:   { type: Number, required: true },
    unitPrice:  { type: Number, required: true },
    lineTotal:  { type: Number, required: true },
    // The REAL buying price per unit, captured from the exact batch(es) FIFO
    // deducted at the moment of sale (quantity-weighted average if the sale
    // spanned more than one batch). null only for lines with no productId
    // (manual scan fallback) or receipts predating this field.
    costPriceAtSale: { type: Number, default: null },
    vatClass: { type: String, enum: ["standard", "zero", "exempt"], default: "standard" },
    originalUnitPrice: { type: Number, default: null },
    promotionApplied: { type: mongoose.Schema.Types.ObjectId, ref: "Promotion", default: null },
    promotionName: { type: String, default: null },
    discountAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

// orderSchema — drop tableNumber/waiterName/servedAt (no kitchen prep step);
// add cashier + branch. "status" now just tracks unpaid/paid/voided in step with Receipt.
const orderSchema = new mongoose.Schema(
  {
    cashier:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    branch:   { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    items:    [orderItemSchema],
    subtotal: { type: Number, required: true },
    vatEnabled: { type: Boolean, default: false },
    vatRate: { type: Number, default: 0 },
    priceMode: { type: String, enum: ["exclusive", "inclusive"], default: "exclusive" },
    vatAmount: { type: Number, default: 0 },
    totalDue: { type: Number, required: true }, 
    status: { type: String, enum: ["pending", "completed", "cancelled"], default: "pending" },
    source: { type: String, enum: ["staff", "online"], default: "staff" },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    customerName: { type: String, default: null },
    cancelledAt: { type: Date, default: null },

    // ---- Offline sync fields ----
    // Generated client-side the instant checkout is tapped, online or off.
    // The single source of truth for "have I already saved this sale?" — a
    // flaky connection means the client can never fully trust whether a
    // request landed, so it always retries with the SAME key. The server
    // uses this to recognize a retry and hand back the original order
    // instead of creating (and stock-deducting) a duplicate sale.
    clientSaleId: { type: String, default: null },
    // The moment the sale actually happened on the till, which for a queued
    // offline sale can be hours before it reaches the server. Reports
    // (today's revenue, shift totals) should read off this, not createdAt —
    // createdAt is "when the database learned about it", soldAt is "when
    // the customer paid".
    soldAt: { type: Date, default: Date.now },
    // True only for a sale that was queued offline and replayed later via
    // the batch sync endpoint — lets reporting/support distinguish "this
    // was rung up live" from "this arrived as a backlog item".
    syncedFromOffline: { type: Boolean, default: false },
    // Set true if, at sync time, the stock this sale deducted had already
    // gone negative — meaning another register (online or a different
    // offline queue) sold the same units first. The sale itself is never
    // rejected for this; it already happened and was paid for. This just
    // flags it so a manager can reconcile the resulting stock count.
    stockDiscrepancy: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Sparse so millions of ordinary (non-offline, pre-existing) orders with no
// clientSaleId never collide with each other — only actual duplicate keys
// are ever rejected.
orderSchema.index({ clientSaleId: 1 }, { unique: true, sparse: true });
orderSchema.index({ branch: 1, soldAt: -1 });

export default mongoose.model("Order", orderSchema);
export { orderItemSchema };
