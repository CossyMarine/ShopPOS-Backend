// routes/stockAdjustmentRoutes.js
import express from "express";
import {
  createStockAdjustment,
  getStockAdjustments,
  approveStockAdjustment,
  rejectStockAdjustment,
  getAuditLog,
  getShrinkageByShift,
} from "../controllers/stockAdjustmentController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";
import {
  validateCreateStockAdjustment,
  validateAdjustmentId,
  validateRejectStockAdjustment,
} from "../Middlewares/validators/stockAdjustmentValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();

router.post(
  "/",
  protect,
  authorize("cashier", "storekeeper", "branchManager", "admin"),
  sameBranch,
  validateCreateStockAdjustment,
  validate,
  createStockAdjustment
);
router.get("/audit-log", protect, authorize("branchManager", "admin"), getAuditLog);
router.get("/shrinkage-by-shift", protect, authorize("branchManager", "admin"), getShrinkageByShift);
router.get("/", protect, authorize("branchManager", "admin"), getStockAdjustments);
router.patch(
  "/:id/approve",
  protect,
  authorize("branchManager", "admin"),
  validateAdjustmentId,
  validate,
  approveStockAdjustment
);
router.patch(
  "/:id/reject",
  protect,
  authorize("branchManager", "admin"),
  validateRejectStockAdjustment,
  validate,
  rejectStockAdjustment
);

export default router;
