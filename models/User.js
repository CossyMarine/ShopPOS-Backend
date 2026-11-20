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
      enum: ["cashier", "storekeeper", "branchManager", "staff", "customer"],
      default: "customer",
    },

    // Extra screens this staff member may also work in (admin-toggleable).
    // Everything they do there is recorded under their OWN account.
    extraRoles: {
      type: [String],
      enum: ["cashier", "storekeeper"],
      default: [],
    },

    jobTitle: { type: String, default: null },

    isActive: { type: Boolean, default: true },

    // Null for Super Admin (sees every branch) and for customers.
    // Required in practice for cashier/storekeeper/branchManager.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },
    selectedBranch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },

        // Admin dashboard look — saved per user so it survives logout/devices
    dashboardPrefs: {
      theme: { type: String, enum: ["classic", "brand", "mono"], default: "classic" }, // green / orange / black&white
      chartStyle: { type: String, enum: ["line", "bar"], default: "line" },
    },

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

        // ── Customer Display ──
    displayPinHash: { type: String, select: false },          // bcrypt, never the password field
    displayPinFailed: { type: Number, default: 0, select: false },
    displayPinLockedUntil: { type: Date, default: null, select: false },
    displaySessionVersion: { type: Number, default: 0 },      // bump = every open Display is kicked out
    displayTillNumber: { type: String, default: null, trim: true },
    displayTillName: { type: String, default: null, trim: true },

    //Employment date
    employmentStartDate: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
