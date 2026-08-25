// routes/orderRoutes.js
import express from "express";
import { createOrder } from "../controllers/orderController.js";
import { protect, authorize, requireOpenShift } from "../Middlewares/authMiddleware.js";
import { validateCreateOrder } from "../Middlewares/validators/orderValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();

// Finalizes a checkout: creates the sale, deducts stock FIFO, generates the receipt
router.post(
  "/",
  protect,
  authorize("cashier", "branchManager", "admin"),
  requireOpenShift,
  validateCreateOrder,
  validate,
  createOrder
);

export default router;
