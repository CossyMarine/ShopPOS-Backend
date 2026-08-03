// models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true, // allows many docs with no email
    },
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // allows many docs with no phone
    },
    password: { type: String, required: true }, // bcrypt hash

    // true = Super Admin — full access across every branch.
    // isAdmin: true always routes to /admin regardless of `role`.
    isAdmin: {
      type: Boolean,
      default: false,
    },

    // Only meaningful when isAdmin is false.
    role: {
      type: String,
      enum: ["cashier", "storekeeper", "branchManager", "customer"],
      default: "customer",
    },

    isActive: { type: Boolean, default: true },

    // Null for Super Admin (sees every branch) and for customers.
    // Required in practice for cashier/storekeeper/branchManager.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },
    selectedBranch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },

    // Reward/cashback points balance — only meaningful for role: "customer"
    walletPoints: { type: Number, default: 0 },

    // Wishlist — Customer Portal "Favorites" tab
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],

    // Password reset (forgot password) — numeric code flow
    resetCode: { type: String, select: false },            // sha256 hash of the 6-digit code
    resetCodeExpires: { type: Date, select: false },
    resetCodeAttempts: { type: Number, default: 0, select: false },
    resetCodeChannel: { type: String, enum: ["email", "sms", "whatsapp"], select: false },
    resetCodeLastSentAt: { type: Date, select: false },     // cooldown for resend

    resetToken: { type: String, select: false },            // short-lived token after code is verified
    resetTokenExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
