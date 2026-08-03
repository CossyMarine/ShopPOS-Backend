// routes/authRoutes.js
import express from "express";
import rateLimit from "express-rate-limit";
import {
  login,
  logout,
  getMe,
  createUser,
  getCashiers,
  registerCustomer,
  checkAvailability,
  getAllUsers,
  getAllUsersIncludingCustomers,
  getStaffCount,
  updateUserRole,
  toggleUserStatus,
  updateMe,
  updateSelectedBranch,
  changePassword,
  forgotPassword,
  resendResetCode,
  verifyResetCode,
  resetPasswordWithCode,
} from "../controllers/authController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { message: "Too many requests. Please try again later." },
});

router.post("/login", login);
router.post("/logout", logout);
router.get("/me", protect, getMe);
router.patch("/me", protect, updateMe);
router.patch("/selected-branch", protect, authorize("admin"), updateSelectedBranch);
router.put("/change-password", protect, changePassword);
router.get("/check-availability", checkAvailability);
router.post("/register-customer", registerCustomer);
router.post("/register", protect, authorize("admin"), createUser);
router.get("/cashiers", protect, getCashiers);

// Forgot password (numeric code flow — email via Resend, phone via OpenSMS SMS/WhatsApp)
router.post("/forgot-password", resetLimiter, forgotPassword);
router.post("/resend-reset-code", resetLimiter, resendResetCode);
router.post("/verify-reset-code", resetLimiter, verifyResetCode);
router.post("/reset-password", resetLimiter, resetPasswordWithCode);

// Staff directory — GET is admin OR branchManager (their own branch, matching
// the "manager shares almost everything with admin" spec); role/status
// changes stay admin-only since only Super Admin should promote/demote.
router.get("/users", protect, authorize("admin", "branchManager"), getAllUsers);
router.get("/users/all", protect, authorize("admin", "branchManager"), getAllUsersIncludingCustomers);
router.get("/staff-count", protect, authorize("admin", "branchManager"), getStaffCount);
router.patch("/users/:id/role", protect, authorize("admin"), updateUserRole);
router.patch("/users/:id/status", protect, authorize("admin"), toggleUserStatus);

export default router;
