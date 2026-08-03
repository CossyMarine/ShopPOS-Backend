// routes/receiptRoutes.js
import express from "express";
import {
  payReceipt,
  payCashAndTill,
  payCombo,
  initiateMpesaPayment,
  mpesaCallback,
  getMpesaStatus,
  cancelMpesaPayment,
  getReceipts,
  getPaidReceipts,
  getReceiptsTodaySummary,
  getReceiptsByCashier,
  getReceiptById,
  getReceiptHistory,
  getReceiptHistoryByCashier,
  addItemsToReceipt,
  markReceiptPrinted,
  cancelUnpaidReceipt,
  getPendingOnlineReceipts,
} from "../controllers/receiptController.js";
import { protect, authorize, requireOpenShift, sameBranch } from "../Middlewares/authMiddleware.js";

const router = express.Router();

const posStaff = authorize("cashier", "branchManager", "admin");

// Payment — the actual register checkout flow
router.patch("/:id/pay", protect, posStaff, requireOpenShift, payReceipt);
router.patch("/:id/pay/cash-till", protect, posStaff, requireOpenShift, payCashAndTill);
router.patch("/:id/pay/combo", protect, posStaff, requireOpenShift, payCombo);
router.post("/:id/mpesa/initiate", protect, posStaff, requireOpenShift, initiateMpesaPayment);
router.get("/:id/mpesa/status", protect, posStaff, getMpesaStatus);
router.post("/:id/mpesa/cancel", protect, posStaff, cancelMpesaPayment);

// Public Safaricom webhook — no auth
router.post("/mpesa/callback", mpesaCallback);

router.patch("/:id/items", protect, posStaff, addItemsToReceipt);
router.patch("/:id/print", protect, markReceiptPrinted);

// Abandoned checkout — cashier closed the payment popup, or the tab/window
// was closed, before any payment landed. Restocks and voids the bill.
router.post("/:id/cancel", protect, posStaff, cancelUnpaidReceipt);

router.get("/", protect, posStaff, sameBranch, getReceipts);
router.get("/paid", protect, authorize("branchManager", "admin"), sameBranch, getPaidReceipts);
router.get("/summary/today", protect, posStaff, sameBranch, getReceiptsTodaySummary);
router.get("/online-pending", protect, posStaff, sameBranch, getPendingOnlineReceipts);

router.get("/cashier/:name/history", protect, getReceiptHistoryByCashier);
router.get("/cashier/:name", protect, getReceiptsByCashier);
router.get("/history", protect, posStaff, getReceiptHistory);

router.get("/:id", protect, getReceiptById);

export default router;
