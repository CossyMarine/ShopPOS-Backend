// controllers/authController.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import crypto from "crypto";
import sendResetEmail from "../utils/sendResetEmail.js";
import { sendResetCode } from "../utils/sendResetSms.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";

// ======================= HELPERS =======================

const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, isAdmin: user.isAdmin, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

const getCookieOptions = () => {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
};

const publicUser = (user) => ({
  id: user._id,
  fullName: user.fullName,
  email: user.email || null,
  phone: user.phone || null,
  isAdmin: user.isAdmin,
  role: user.role,
  jobTitle: user.jobTitle || null,
  branch: user.branch || null,
  selectedBranch: user.selectedBranch || null,
});

// Fuller shape for the admin Users panel — includes status + join date + branch
const adminUserView = (user) => ({
  id: user._id,
  fullName: user.fullName,
  email: user.email || null,
  phone: user.phone || null,
  isAdmin: user.isAdmin,
  role: user.role,
  jobTitle: user.jobTitle || null,
  branch: user.branch || null,
  isActive: user.isActive,
  createdAt: user.createdAt,
  employmentStartDate: !isAdmin && employmentStartDate ? new Date(employmentStartDate) : null,
});

const STAFF_ROLES = ["cashier", "storekeeper", "branchManager", "staff"];
const STAFF_ROLES_LABEL = "cashier, storekeeper, branchManager, or staff";

// NOTE: none of the logging added below ever prints a password, reset
// code, reset token, or password hash — only identifiers (email/phone),
// user ids, and outcome/reason. Keep it that way in any future edits here.

// ======================= LOGIN =======================
// @desc    Authenticate any user (customer, cashier, storekeeper, branchManager, admin)
//          by email or phone — cookie-based session: find -> compare password ->
//          check account status -> sign -> cookie.
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
  try {
    let { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ message: "Enter your email/phone and password" });
    }

    identifier = identifier.trim();
    const value = identifier.toLowerCase();

    logStart("auth", "Login attempt", { identifier });

    const user = await User.findOne({
      $or: [{ email: value }, { phone: identifier }],
    });

    if (!user) {
      console.warn(`[auth] ⚠️ Login failed — no account for "${identifier}"`);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.warn(`[auth] ⚠️ Login failed — wrong password for user ${user._id}`);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.isActive) {
      console.warn(`[auth] ⚠️ Login blocked — account ${user._id} is deactivated`);
      return res.status(403).json({
        message: "Your account has been deactivated. Contact your admin.",
      });
    }

    const token = generateToken(user);
    res.cookie("token", token, getCookieOptions());

    logSuccess("auth", "Login successful", { userId: user._id, role: user.role, isAdmin: user.isAdmin });
    res.json({ user: publicUser(user) });
  } catch (error) {
    logError("auth", "Login error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Clear the session cookie
// @route   POST /api/auth/logout
// @access  Public
export const logout = async (req, res) => {
  res.clearCookie("token", getCookieOptions());
  console.log(`[auth] ✅ Logged out${req.user ? ` — user ${req.user._id}` : ""}`);
  res.json({ message: "Logged out" });
};

// @desc    Return the logged-in user
// @route   GET /api/auth/me
// @access  Protected
export const getMe = async (req, res) => {
  res.json({ user: publicUser(req.user) });
};

// @desc    Check if an email/phone is already taken
// @route   GET /api/auth/check-availability?field=email&value=jane@mail.com
// @access  Public
export const checkAvailability = async (req, res) => {
  try {
    const { field, value } = req.query;

    if (!field || !value || !["email", "phone"].includes(field)) {
      return res.status(400).json({ message: "Invalid check request" });
    }

    const clean = field === "phone" ? value.trim() : value.toLowerCase().trim();
    const existing = await User.findOne({ [field]: clean }).select("_id");

    res.json({ available: !existing });
  } catch (error) {
    logError("auth", "Check availability error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= REGISTER (customer self-signup) =======================
// @route   POST /api/auth/register-customer
// @access  Public
export const registerCustomer = async (req, res) => {
  try {
    let { fullName, method, contact, password } = req.body;

    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    fullName = fullName.trim();
    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

    logStart("auth", "Registering customer", { method, contact: cleanContact });

    const contactTaken = await User.findOne({ [method]: cleanContact });
    if (contactTaken) {
      console.warn(`[auth] ⚠️ Registration blocked — ${method} already taken: ${cleanContact}`);
      return res.status(400).json({
        message: method === "email" ? "This email is already registered" : "This phone number is already registered",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      fullName,
      password: hashedPassword,
      isAdmin: false,
      role: "customer",
      [method]: cleanContact,
    });

    const token = generateToken(user);
    res.cookie("token", token, getCookieOptions());

    logSuccess("auth", "Customer registered", { userId: user._id, method });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    logError("auth", "Register customer error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= REGISTER (staff, admin-only) =======================
// @route   POST /api/auth/register
// @access  Protected — admin
export const createUser = async (req, res) => {
  try {
    let { fullName, method, contact, password, isAdmin, role, branch, jobTitle ,employmentStartDate} = req.body;

    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }
    if (!isAdmin) {
      if (!STAFF_ROLES.includes(role)) {
        return res.status(400).json({ message: `Choose a role: ${STAFF_ROLES_LABEL}` });
      }
      if (!branch) {
        return res.status(400).json({ message: "A branch is required for this role" });
      }
    }

    fullName = fullName.trim();
    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

    logStart("auth", "Creating staff user", { fullName, method, role: isAdmin ? "admin" : role, branch });

    const existing = await User.findOne({ [method]: cleanContact });
    if (existing) {
      console.warn(`[auth] ⚠️ User creation blocked — ${method} already exists: ${cleanContact}`);
      return res.status(400).json({ message: "A user with that email/phone already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      fullName,
      password: hashedPassword,
      isAdmin: !!isAdmin,
      role: isAdmin ? "customer" : role,
      branch: isAdmin ? null : branch,
      jobTitle: !isAdmin && role === "staff" ? (jobTitle?.trim() || null) : null,
      employmentStartDate: !isAdmin && employmentStartDate ? new Date(employmentStartDate) : null,
      [method]: cleanContact,
    });

    logSuccess("auth", "Staff user created", { userId: user._id, role: user.role, isAdmin: user.isAdmin });
    res.status(201).json({
      message: "User created successfully",
      user: adminUserView(user),
    });
  } catch (error) {
    logError("auth", "Create user error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get the cashier list for the CURRENT logged-in user's branch —
//          used by shared-register "who's opening the till" dropdowns.
//          Super Admin sees every cashier across every branch.
// @route   GET /api/auth/cashiers
// @access  Protected
export const getCashiers = async (req, res) => {
  try {
    const filter = { role: "cashier", isActive: true };
    if (!req.user.isAdmin) filter.branch = req.user.branch;

    const cashiers = await User.find(filter).select("fullName branch").sort({ fullName: 1 });

    res.json(cashiers.map((c) => ({ id: c._id, fullName: c.fullName, branch: c.branch })));
  } catch (error) {
    logError("auth", "Get cashiers error", error);
    res.status(500).json({ message: "Failed to fetch cashiers" });
  }
};

// @desc    Get every staff/admin account for the admin Users panel (customers excluded)
// @route   GET /api/auth/users
// @access  Protected — admin
export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({
      $or: [{ isAdmin: true }, { role: { $ne: "customer" } }],
    })
      .populate("branch", "name")
      .sort({ createdAt: -1 });

    res.json(users.map(adminUserView));
  } catch (error) {
    logError("auth", "Get all users error", error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
};

// @desc    Get EVERY user, including normal customers — used by the Users
//          panel's "All Users" view so customers can be promoted to staff.
// @route   GET /api/auth/users/all
// @access  Protected — admin
export const getAllUsersIncludingCustomers = async (req, res) => {
  try {
    const users = await User.find({}).populate("branch", "name").sort({ createdAt: -1 });
    res.json(users.map(adminUserView));
  } catch (error) {
    logError("auth", "Get all users (incl. customers) error", error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
};

// @desc    Count of staff/admin accounts (customers excluded) — Dashboard metric
// @route   GET /api/auth/staff-count
// @access  Protected — admin
export const getStaffCount = async (req, res) => {
  try {
    const totalStaff = await User.countDocuments({
      $or: [{ isAdmin: true }, { role: { $ne: "customer" } }],
    });
    res.json({ totalStaff });
  } catch (error) {
    logError("auth", "Get staff count error", error);
    res.status(500).json({ message: "Failed to fetch staff count" });
  }
};

// @desc    Promote/change a user's role — works for staff AND customers,
//          so a normal customer account can be promoted to staff/admin.
//          Body: { isAdmin: true } -> full Super Admin
//          Body: { role: "cashier" | "storekeeper" | "branchManager" | "staff", branch, jobTitle } -> staff role
// @route   PATCH /api/auth/users/:id/role
// @access  Protected — admin
export const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { isAdmin, role, branch, jobTitle } = req.body;

    logStart("auth", "Updating user role", { userId: id, isAdmin, role, branch });

    if (req.user._id.toString() === id) {
      console.warn(`[auth] ⚠️ User ${id} tried to change their own role — blocked`);
      return res.status(400).json({ message: "You can't change your own role" });
    }

    const user = await User.findById(id);
    if (!user) {
      console.warn(`[auth] ⚠️ User not found: ${id}`);
      return res.status(404).json({ message: "User not found" });
    }

    if (isAdmin) {
      user.isAdmin = true;
      user.branch = null;
      user.jobTitle = null;
    } else {
      if (!STAFF_ROLES.includes(role)) {
        return res.status(400).json({ message: `Choose a role: ${STAFF_ROLES_LABEL}` });
      }
      if (!branch) {
        return res.status(400).json({ message: "A branch is required for this role" });
      }
      user.isAdmin = false;
      user.role = role;
      user.branch = branch;
      user.jobTitle = role === "staff" ? (jobTitle?.trim() || null) : null;
    }

    await user.save();

    logSuccess("auth", "User role updated", { userId: id, newRole: user.isAdmin ? "admin" : user.role });
    res.json({ message: "Role updated successfully", user: adminUserView(user) });
  } catch (error) {
    logError("auth", "Update user role error", error);
    res.status(500).json({ message: "Failed to update role" });
  }
};

// @desc    Activate or deactivate any account
// @route   PATCH /api/auth/users/:id/status
// @access  Protected — admin
export const toggleUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    logStart("auth", "Toggling user status", { userId: id });

    if (req.user._id.toString() === id) {
      console.warn(`[auth] ⚠️ User ${id} tried to deactivate themselves — blocked`);
      return res.status(400).json({ message: "You can't deactivate your own account" });
    }

    const user = await User.findById(id);
    if (!user) {
      console.warn(`[auth] ⚠️ User not found: ${id}`);
      return res.status(404).json({ message: "User not found" });
    }

    user.isActive = !user.isActive;
    await user.save();

    logSuccess("auth", "User status toggled", { userId: id, isActive: user.isActive });
    res.json({ message: "Status updated", user: adminUserView(user) });
  } catch (error) {
    logError("auth", "Toggle user status error", error);
    res.status(500).json({ message: "Failed to update status" });
  }
};

// @desc    Update the logged-in user's own contact info (email/phone/name).
//          Used by Profile > Personal Details — lets a user add whichever
//          of email/phone they're missing (or edit the one they have).
// @route   PATCH /api/auth/me
// @access  Protected
export const updateMe = async (req, res) => {
  try {
    let { fullName, email, phone } = req.body;
    const user = await User.findById(req.user._id);

    logStart("auth", "Updating own profile", { userId: req.user._id, fieldsChanged: Object.keys(req.body) });

    if (fullName !== undefined) {
      fullName = fullName.trim();
      if (!fullName) {
        return res.status(400).json({ message: "Full name can't be empty" });
      }
      user.fullName = fullName;
    }

    if (email !== undefined && email !== null && email !== "") {
      const cleanEmail = email.toLowerCase().trim();
      if (cleanEmail !== (user.email || "")) {
        const taken = await User.findOne({ email: cleanEmail, _id: { $ne: user._id } });
        if (taken) {
          console.warn(`[auth] ⚠️ Email already registered: ${cleanEmail}`);
          return res.status(400).json({ message: "This email is already registered" });
        }
        user.email = cleanEmail;
      }
    }

    if (phone !== undefined && phone !== null && phone !== "") {
      const cleanPhone = phone.trim();
      if (cleanPhone !== (user.phone || "")) {
        const taken = await User.findOne({ phone: cleanPhone, _id: { $ne: user._id } });
        if (taken) {
          console.warn(`[auth] ⚠️ Phone already registered: ${cleanPhone}`);
          return res.status(400).json({ message: "This phone number is already registered" });
        }
        user.phone = cleanPhone;
      }
    }

    if (!user.email && !user.phone) {
      return res.status(400).json({ message: "You must have at least one of email or phone" });
    }

    await user.save();

    logSuccess("auth", "Own profile updated", { userId: user._id });
    res.json({ user: publicUser(user) });
  } catch (error) {
    logError("auth", "Update me error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Persist which branch the Super Admin is currently viewing, so it's
//          restored automatically on next login/refresh — and so anywhere
//          that adds products/stock knows which branch to save them under.
// @route   PATCH /api/auth/selected-branch
// @access  Admin only
export const updateSelectedBranch = async (req, res) => {
  try {
    const { branch } = req.body;
    logStart("auth", "Updating selected branch", { userId: req.user._id, branch });

    if (branch) {
      const Branch = (await import("../models/Branch.js")).default;
      const exists = await Branch.findById(branch).select("_id");
      if (!exists) {
        console.warn(`[auth] ⚠️ Branch not found: ${branch}`);
        return res.status(400).json({ message: "Branch not found" });
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { selectedBranch: branch || null },
      { new: true }
    );

    logSuccess("auth", "Selected branch updated", { userId: req.user._id, branch });
    res.json({ user: publicUser(user) });
  } catch (error) {
    logError("auth", "Update selected branch error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Change the logged-in user's own password
// @route   PUT /api/auth/change-password
// @access  Protected
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    logStart("auth", "Changing password", { userId: req.user._id });

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "New passwords don't match" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }

    const user = await User.findById(req.user._id); // req.user has password excluded, refetch full doc
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      console.warn(`[auth] ⚠️ Password change failed — current password incorrect for user ${req.user._id}`);
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    logSuccess("auth", "Password changed", { userId: req.user._id });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    logError("auth", "Change password error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= FORGOT PASSWORD HELPERS =======================
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

const generateNumericCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit numeric

const maskContact = (value, method) => {
  if (method === "email") {
    const [name, domain] = value.split("@");
    return `${name.slice(0, 2)}${"*".repeat(Math.max(name.length - 2, 1))}@${domain}`;
  }
  return value.slice(0, -4).replace(/./g, "*") + value.slice(-4);
};

const RESEND_COOLDOWN_MS = 60 * 1000; // 60s between sends
const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

// ======================= FORGOT PASSWORD (step 1: request code) =======================
// @route   POST /api/auth/forgot-password
// @body    { identifier }  -- email OR phone
// @access  Public
export const forgotPassword = async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ message: "Enter your email or phone number" });
    }

    const value = identifier.trim();
    const method = isEmail(value) ? "email" : "phone";
    const clean = method === "email" ? value.toLowerCase() : value;

    logStart("auth", "Forgot password requested", { method, contact: maskContact(clean, method) });

    const user = await User.findOne({ [method]: clean }).select(
      "+resetCode +resetCodeExpires +resetCodeAttempts +resetCodeChannel +resetCodeLastSentAt"
    );

    if (!user) {
      console.warn(`[auth] ⚠️ Forgot-password — no account for ${method}: ${maskContact(clean, method)}`);
      return res.status(404).json({
        notFound: true,
        message: "No account found with that email or phone number.",
      });
    }

    if (user.resetCodeLastSentAt && Date.now() - user.resetCodeLastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - user.resetCodeLastSentAt.getTime())) / 1000
      );
      console.warn(`[auth] ⚠️ Reset code cooldown active for user ${user._id} — wait ${waitSec}s`);
      return res.status(429).json({ message: `Please wait ${waitSec}s before requesting another code.` });
    }

    const code = generateNumericCode();
    const channel = method === "email" ? "email" : "sms"; // phone defaults to SMS first

    user.resetCode = hashCode(code);
    user.resetCodeExpires = new Date(Date.now() + CODE_EXPIRY_MS);
    user.resetCodeAttempts = 0;
    user.resetCodeChannel = channel;
    user.resetCodeLastSentAt = new Date();
    await user.save();

    try {
      if (method === "email") {
        await sendResetEmail({ to: user.email, code, fullName: user.fullName });
      } else {
        await sendResetCode({ to: user.phone, code, channel: "sms" });
      }
    } catch (sendErr) {
      logError("auth", "Failed to send reset code", sendErr);
      return res.status(500).json({ message: "Failed to send reset code. Please try again." });
    }

    logSuccess("auth", "Reset code sent", { userId: user._id, channel });
    res.json({
      message: `A reset code was sent via ${channel}.`,
      method,
      channel,
      maskedContact: maskContact(clean, method),
    });
  } catch (error) {
    logError("auth", "Forgot password error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= RESEND CODE (SMS <-> WhatsApp switch) =======================
// @route   POST /api/auth/resend-reset-code
// @body    { identifier, channel }  -- channel: "sms" | "whatsapp" (phone only)
// @access  Public
export const resendResetCode = async (req, res) => {
  try {
    const { identifier, channel } = req.body;
    if (!identifier) return res.status(400).json({ message: "Missing identifier" });

    const value = identifier.trim();
    const method = isEmail(value) ? "email" : "phone";
    const clean = method === "email" ? value.toLowerCase() : value;

    logStart("auth", "Resending reset code", { method, contact: maskContact(clean, method), requestedChannel: channel });

    const user = await User.findOne({ [method]: clean }).select(
      "+resetCode +resetCodeExpires +resetCodeAttempts +resetCodeChannel +resetCodeLastSentAt"
    );
    if (!user) {
      console.warn(`[auth] ⚠️ Resend — no account for ${method}: ${maskContact(clean, method)}`);
      return res.status(404).json({ notFound: true, message: "Account not found" });
    }

    if (user.resetCodeLastSentAt && Date.now() - user.resetCodeLastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - user.resetCodeLastSentAt.getTime())) / 1000
      );
      console.warn(`[auth] ⚠️ Resend cooldown active for user ${user._id} — wait ${waitSec}s`);
      return res.status(429).json({ message: `Please wait ${waitSec}s before resending.` });
    }

    const code = generateNumericCode();
    const useChannel = method === "phone" && channel === "whatsapp" ? "whatsapp" : method === "email" ? "email" : "sms";

    user.resetCode = hashCode(code);
    user.resetCodeExpires = new Date(Date.now() + CODE_EXPIRY_MS);
    user.resetCodeAttempts = 0;
    user.resetCodeChannel = useChannel;
    user.resetCodeLastSentAt = new Date();
    await user.save();

    if (method === "email") {
      await sendResetEmail({ to: user.email, code, fullName: user.fullName });
    } else {
      await sendResetCode({ to: user.phone, code, channel: useChannel });
    }

    logSuccess("auth", "Reset code resent", { userId: user._id, channel: useChannel });
    res.json({ message: `Code resent via ${useChannel}.`, channel: useChannel });
  } catch (error) {
    logError("auth", "Resend reset code error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= VERIFY CODE (step 2) =======================
// @route   POST /api/auth/verify-reset-code
// @body    { identifier, code }
// @access  Public
export const verifyResetCode = async (req, res) => {
  try {
    const { identifier, code } = req.body;
    if (!identifier || !code) {
      return res.status(400).json({ message: "Identifier and code are required" });
    }

    const value = identifier.trim();
    const method = isEmail(value) ? "email" : "phone";
    const clean = method === "email" ? value.toLowerCase() : value;

    logStart("auth", "Verifying reset code", { method, contact: maskContact(clean, method) });

    const user = await User.findOne({ [method]: clean }).select(
      "+resetCode +resetCodeExpires +resetCodeAttempts"
    );
    if (!user || !user.resetCode) {
      console.warn(`[auth] ⚠️ Verify — invalid/expired code for ${method}: ${maskContact(clean, method)}`);
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    if (user.resetCodeExpires < new Date()) {
      console.warn(`[auth] ⚠️ Verify — code expired for user ${user._id}`);
      return res.status(400).json({ message: "Code expired. Please request a new one." });
    }

    if (user.resetCodeAttempts >= MAX_ATTEMPTS) {
      console.warn(`[auth] ⚠️ Verify — too many attempts for user ${user._id}`);
      return res.status(429).json({ message: "Too many attempts. Please request a new code." });
    }

    if (hashCode(code.trim()) !== user.resetCode) {
      user.resetCodeAttempts += 1;
      await user.save();
      console.warn(`[auth] ⚠️ Verify — incorrect code for user ${user._id} (attempt ${user.resetCodeAttempts}/${MAX_ATTEMPTS})`);
      return res.status(400).json({ message: "Incorrect code" });
    }

    // Code correct — issue a short-lived reset token, clear the code
    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetToken = hashCode(resetToken);
    user.resetTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
    user.resetCode = undefined;
    user.resetCodeExpires = undefined;
    user.resetCodeAttempts = 0;
    await user.save();

    logSuccess("auth", "Reset code verified", { userId: user._id });
    res.json({ message: "Code verified", resetToken });
  } catch (error) {
    logError("auth", "Verify reset code error", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= RESET PASSWORD (step 3) =======================
// @route   POST /api/auth/reset-password
// @body    { resetToken, newPassword }
// @access  Public
export const resetPasswordWithCode = async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    logStart("auth", "Resetting password via token");

    if (!resetToken || !newPassword) {
      return res.status(400).json({ message: "Missing reset token or new password" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const user = await User.findOne({
      resetToken: hashCode(resetToken),
      resetTokenExpires: { $gt: new Date() },
    }).select("+resetToken +resetTokenExpires");

    if (!user) {
      console.warn("[auth] ⚠️ Reset password — invalid or expired token");
      return res.status(400).json({ message: "Invalid or expired session. Please start over." });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.resetToken = undefined;
    user.resetTokenExpires = undefined;
    await user.save();

    logSuccess("auth", "Password reset via token", { userId: user._id });
    res.json({ message: "Password reset successful" });
  } catch (error) {
    logError("auth", "Reset password error", error);
    res.status(500).json({ message: "Server error" });
  }
};
