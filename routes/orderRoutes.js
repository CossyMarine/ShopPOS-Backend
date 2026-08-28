// routes/orderRoutes.js
import express from "express";
import { createOrder } from "../controllers/orderController.js";
import { syncOfflineOrders } from "../controllers/offlineSyncController.js";
import { protect, authorize, requireOpenShift } from "../Middlewares/authMiddleware.js";
import { validateCreateOrder, validateSyncBatch } from "../Middlewares/validators/orderValidators.js";
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

// Replays a backlog of sales queued while the device was offline. No
// requireOpenShift here — these sales already happened under a shift that
// was open on the device at the time; by the time they sync, that shift may
// have legitimately closed already.
router.post(
  "/sync-batch",
  protect,
  authorize("cashier", "branchManager", "admin"),
  validateSyncBatch,
  validate,
  syncOfflineOrders
);

export default router;
