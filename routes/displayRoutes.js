import express from "express";
import rateLimit from "express-rate-limit";
import { protect, protectDisplay, authorize } from "../Middlewares/authMiddleware.js";
import {
  getStatus, setPin, pushCart, pushBill, displayMe, socketTicket, displayLogout,
  getCashierDisplay, setCashierTill, resetCashierPin,
} from "../controllers/displayController.js";

const router = express.Router();
const pinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { message: "Too many attempts. Try again later." } });
const cashierOnly = [protect, authorize("admin", "cashier")];
const manager = [protect, authorize("admin", "branchManager")];

// Display screen (displayToken)
router.get("/me", protectDisplay, displayMe);
router.get("/socket-ticket", protectDisplay, socketTicket);
router.post("/logout", displayLogout);

// Cashier dashboard (normal token)
router.get("/status", ...cashierOnly, getStatus);
router.put("/pin", ...cashierOnly, pinLimiter, setPin);
router.post("/cart", ...cashierOnly, pushCart);
router.post("/bill", ...cashierOnly, pushBill);

// Admin / branch manager
router.get("/cashiers/:id", ...manager, getCashierDisplay);
router.patch("/cashiers/:id/till", ...manager, setCashierTill);
router.post("/cashiers/:id/reset-pin", ...manager, resetCashierPin);

export default router;
