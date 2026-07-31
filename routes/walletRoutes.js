// routes/walletRoutes.js
import express from "express";
import { protect, authorize, requireOpenShift } from "../Middlewares/authMiddleware.js";
import {
  getMyWallet,
  resolveBill,
  payWithManualTill,
  payWithStk,
  getWalletStkStatus,
  payWithReward,
  adminAddReward,
  adminPayWithReward,
  getMyBillHistory,
} from "../controllers/walletController.js";

const router = express.Router();

router.get("/me", protect, getMyWallet);
router.post("/resolve-bill", protect, resolveBill);
router.post("/pay/manual", protect, payWithManualTill);
router.post("/pay/stk", protect, payWithStk);
router.get("/pay/stk/:receiptId/status", protect, getWalletStkStatus);
router.post("/pay/reward", protect, payWithReward);

// "Ask if that customer should be rewarded" — any till-facing staff can award,
// matching the cashier PaymentModal flow, not just admin.
router.post("/admin/add-reward", protect, authorize("admin", "branchManager", "cashier"), adminAddReward);
router.post("/admin/pay-with-reward", protect, authorize("admin", "branchManager", "cashier"), requireOpenShift, adminPayWithReward);

router.get("/history", protect, authorize("customer"), getMyBillHistory);

export default router;
