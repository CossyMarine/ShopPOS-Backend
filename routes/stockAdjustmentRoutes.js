// routes/stockAdjustmentRoutes.js
import express from "express";
import {
  createStockAdjustment,
  getStockAdjustments,
  approveStockAdjustment,
  rejectStockAdjustment,
  getAuditLog,
} from "../controllers/stockAdjustmentController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.post(
  "/",
  protect,
  authorize("cashier", "storekeeper", "branchManager", "admin"),
  sameBranch,
  createStockAdjustment
);
router.get("/audit-log", protect, authorize("branchManager", "admin"), getAuditLog);
router.get("/", protect, authorize("branchManager", "admin"), getStockAdjustments);
router.patch("/:id/approve", protect, authorize("branchManager", "admin"), approveStockAdjustment);
router.patch("/:id/reject", protect, authorize("branchManager", "admin"), rejectStockAdjustment);

export default router;
