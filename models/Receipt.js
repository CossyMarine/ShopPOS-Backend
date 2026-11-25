// models/Receipt.js
import mongoose from "mongoose";
import { orderItemSchema } from "./Order.js";

// One entry per payment towards a bill — supports partial payments,
// multiple methods on the same bill, and a full audit trail.
//
// method "credit" is special: it records that the bill was given on credit
// (the sale), for the full totalDue. It is NOT money received, so it is never
// counted in amountPaid, cash, till or "total money" figures. Money collected
// later is added as normal cash/till entries.
const paymentEntrySchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true },
    method: {
      type: String,
      enum: [
        "cash",
        "mpesa_till",
        "mpesa_paybill",
        "mpesa_pochi",
        "mpesa_stk",
        "manual_till",
        "reward",
        "both",
        "credit",
      ],
      required: true,
    },
    // M-Pesa code, payer's full name (manual till), or a reward note
    reference: { type: String, default: null },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    paidAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    billId: {
      type: String,
      required: true,
      unique: true,
    },

    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    cashierName: {
      type: String,
      default: null,
    },

    // NEW: Indicates where the order originated
    source: {
      type: String,
      enum: ["staff", "online"],
      default: "staff",
    },

    items: [orderItemSchema],

    // Net-of-VAT total when VAT is on and prices are exclusive; equals the
    // rung-up total when VAT is off. Kept for backward compatibility with
    // existing reports — use `totalDue` for what the customer actually owes.
    subtotal: {
      type: Number,
      required: true,
    },

    vatEnabled: { type: Boolean, default: false },
    vatRate: { type: Number, default: 0 },
    priceMode: { type: String, enum: ["exclusive", "inclusive"], default: "exclusive" },
    vatAmount: { type: Number, default: 0 },
    // Authoritative amount owed by the customer — use this everywhere
    // balanceDue/amountPaid/status math happens, not `subtotal`.
    totalDue: { type: Number, required: true },

    // The registered customer this bill belongs to (null for walk-in/guest bills)
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // "credit" = given on credit and still being paid off. It counts as a
    // sale from the day it was given; it becomes "paid" once fully settled.
    status: {
      type: String,
      enum: ["unpaid", "partial", "paid", "voided", "credit"],
      default: "unpaid",
    },

    // "both" = split cash + till payment. Reflects the most recent/primary
    // method — full breakdown lives in `payments`.
    paymentMethod: {
      type: String,
      enum: [
        "cash",
        "mpesa_till",
        "mpesa_paybill",
        "mpesa_pochi",
        "mpesa_stk",
        "manual_till",
        "reward",
        "both",
        "credit",
        null,
      ],
      default: null,
    },

    // Running total of MONEY received across all payments.
    // The "credit" entry in `payments` is not money and is excluded.
    amountPaid: {
      type: Number,
      default: null,
    },

    changeGiven: {
      type: Number,
      default: null,
    },

    // Split breakdown for the classic staff cash/till flow
    cashAmount: {
      type: Number,
      default: 0,
    },

    tillAmount: {
      type: Number,
      default: 0,
    },

    // Full payment history
    payments: [paymentEntrySchema],

    // ---- Reward / cashback tracking ----
    rewardPointsEarned: {
      type: Number,
      default: 0,
    },

    rewardPointsRedeemed: {
      type: Number,
      default: 0,
    },

    rewardKesRedeemed: {
      type: Number,
      default: 0,
    },

    // ---- M-Pesa Daraja STK Push tracking ----
    // "staff" = cashier/admin initiated
    // "wallet" = customer initiated
    mpesaSource: {
      type: String,
      enum: ["staff", "wallet", null],
      default: null,
    },

    mpesaPhone: {
      type: String,
      default: null,
    },

    mpesaCheckoutRequestId: {
      type: String,
      default: null,
      index: true,
    },

    mpesaMerchantRequestId: {
      type: String,
      default: null,
    },

    mpesaReceiptNumber: {
      type: String,
      default: null,
    },

    mpesaResultDesc: {
      type: String,
      default: null,
    },

    mpesaStatus: {
      type: String,
      enum: ["idle", "pending", "success", "failed"],
      default: "idle",
    },

    // Held while an STK push is in flight
    pendingCashAmount: {
      type: Number,
      default: 0,
    },

    pendingTillAmount: {
      type: Number,
      default: 0,
    },

    // Who initiated the wallet payment
    pendingPaidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ---- Customer manual till payment claims ----
    pendingManualPayments: [
      {
        amount: {
          type: Number,
          required: true,
        },

        reference: {
          type: String,
          required: true,
        },

        paidBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },

        paidByName: {
          type: String,
          default: null,
        },

        submittedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    voidReason: {
      type: String,
      default: null,
    },

    // When the receipt was voided. Set once, at the moment status becomes
    // "voided" — unlike updatedAt, later edits never move it. Receipts voided
    // before this field existed have null here; reports fall back to updatedAt.
    voidedAt: {
      type: Date,
      default: null,
    },

    printedAt: {
      type: Date,
      default: null,
    },

    // The sale date used by every report. For normal bills it is when the
    // bill became fully paid. For credit bills it is the day the credit was
    // GIVEN, and it is not moved when the customer later settles.
    paidAt: {
      type: Date,
      default: null,
    },

    printCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

receiptSchema.index({ status: 1, paidAt: 1, branch: 1 });
receiptSchema.index({ branch: 1, createdAt: -1 });

export default mongoose.model("Receipt", receiptSchema);
export { orderItemSchema };
