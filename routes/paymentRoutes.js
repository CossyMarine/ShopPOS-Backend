// routes/paymentRoutes.js
import express from "express";
import {
  getTransactions,
  getPaymentSummary,
  getPendingManualPayments,
  getPendingManualPaymentsCount,
  confirmManualPayment,
  rejectManualPayment,
} from "../controllers/paymentController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/summary", protect, authorize("admin", "branchManager"), sameBranch, getPaymentSummary);
router.get("/transactions", protect, authorize("admin", "branchManager"), sameBranch, getTransactions);
router.get("/pending", protect, authorize("admin", "branchManager"), sameBranch, getPendingManualPayments);
router.get("/pending/count", protect, authorize("admin", "branchManager"), sameBranch, getPendingManualPaymentsCount);

router.patch("/pending/:receiptId/:paymentId/confirm", protect, authorize("admin", "branchManager"), confirmManualPayment);
router.patch("/pending/:receiptId/:paymentId/reject", protect, authorize("admin", "branchManager"), rejectManualPayment);

export default router;
