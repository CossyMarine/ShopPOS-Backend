// routes/receiptRoutes.js
import express from "express";
import rateLimit from "express-rate-limit";
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
import {
  validateReceiptId,
  validatePayReceipt,
  validatePayCashAndTill,
  validatePayCombo,
  validateInitiateMpesaPayment,
  validateAddItemsToReceipt,
} from "../Middlewares/validators/receiptValidators.js";
import { payOnCredit } from "../controllers/creditController.js";
import { validatePayOnCredit } from "../Middlewares/validators/creditValidators.js";
import { validate } from "../Middlewares/validate.js";

// Stops a stuck button or a bad actor from spamming customers' phones with prompts.
const stkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many M-Pesa requests. Wait a minute and try again." },
});

const router = express.Router();

const posStaff = authorize("cashier", "branchManager", "admin");

// Payment — the actual register checkout flow
router.patch("/:id/pay", protect, posStaff, requireOpenShift, validatePayReceipt, validate, payReceipt);
router.patch("/:id/pay/cash-till", protect, posStaff, requireOpenShift, validatePayCashAndTill, validate, payCashAndTill);
router.patch("/:id/pay/combo", protect, posStaff, requireOpenShift, validatePayCombo, validate, payCombo);
router.post("/:id/mpesa/initiate", stkLimiter, protect, posStaff, requireOpenShift, validateInitiateMpesaPayment, validate, initiateMpesaPayment);
router.get("/:id/mpesa/status", protect, posStaff, validateReceiptId, validate, getMpesaStatus);
router.post("/:id/mpesa/cancel", protect, posStaff, validateReceiptId, validate, cancelMpesaPayment);

// Public Safaricom webhook — no auth
router.post("/mpesa/callback", mpesaCallback);

router.patch("/:id/items", protect, posStaff, validateAddItemsToReceipt, validate, addItemsToReceipt);
router.patch("/:id/print", protect, validateReceiptId, validate, markReceiptPrinted);

// Abandoned checkout — cashier closed the payment popup, or the tab/window
// was closed, before any payment landed. Restocks and voids the bill.
router.post("/:id/cancel", protect, posStaff, validateReceiptId, validate, cancelUnpaidReceipt);

router.get("/", protect, posStaff, sameBranch, getReceipts);
router.get("/paid", protect, authorize("branchManager", "admin"), sameBranch, getPaidReceipts);
router.get("/summary/today", protect, posStaff, sameBranch, getReceiptsTodaySummary);
router.get("/online-pending", protect, posStaff, sameBranch, getPendingOnlineReceipts);

router.get("/cashier/:name/history", protect, getReceiptHistoryByCashier);
router.get("/cashier/:name", protect, getReceiptsByCashier);
router.get("/history", protect, posStaff, getReceiptHistory);

router.get("/:id", protect, validateReceiptId, validate, getReceiptById);

router.patch("/:id/pay/credit", protect, posStaff, requireOpenShift, validatePayOnCredit, validate, payOnCredit);
export default router;
