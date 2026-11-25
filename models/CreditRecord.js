// models/CreditRecord.js
import mongoose from "mongoose";

const settlementSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  method: { type: String, enum: ["cash", "manual_till", "mpesa_till"], required: true },
  reference: { type: String, default: null },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  receivedByName: { type: String, default: null },
  paidAt: { type: Date, default: Date.now },
});

const creditRecordSchema = new mongoose.Schema(
  {
    receipt: { type: mongoose.Schema.Types.ObjectId, ref: "Receipt", required: true, unique: true },
    billId: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, default: null, trim: true },
    dueDate: { type: Date, default: null }, // optional intended pay date
    amount: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    status: { type: String, enum: ["open", "partial", "settled", "voided"], default: "open" },
    cashierName: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    settledAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    settlements: [settlementSchema],
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

creditRecordSchema.virtual("balance").get(function () {
  return Number((this.amount - this.amountPaid).toFixed(2));
});

creditRecordSchema.index({ branch: 1, status: 1, dueDate: 1 });
creditRecordSchema.index({ customerName: 1 });

export default mongoose.model("CreditRecord", creditRecordSchema);
