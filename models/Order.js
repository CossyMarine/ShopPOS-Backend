// models/Order.js
import mongoose from "mongoose";

// orderItemSchema — rename menuItemId/mealName to product terms:
const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    productName: { type: String, required: true },
    imageUrl:  { type: String, default: null },
    quantity:  { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
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
    status: { type: String, enum: ["pending", "completed", "cancelled"], default: "pending" },
    source: { type: String, enum: ["staff", "online"], default: "staff" },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    customerName: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
export { orderItemSchema };
