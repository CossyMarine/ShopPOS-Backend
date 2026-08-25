// routes/stockCountRoutes.js
import express from "express";
import {
  startStockCount,
  getStockCounts,
  getStockCountById,
  updateStockCountLines,
  submitStockCount,
  reconcileStockCount,
  cancelStockCount,
} from "../controllers/stockCountController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";
import {
  validateStartStockCount,
  validateStockCountId,
  validateUpdateStockCountLines,
} from "../Middlewares/validators/stockCountValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();

router.post(
  "/",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  sameBranch,
  validateStartStockCount,
  validate,
  startStockCount
);
router.get("/", protect, authorize("storekeeper", "branchManager", "admin"), getStockCounts);
router.get(
  "/:id",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  validateStockCountId,
  validate,
  getStockCountById
);
router.patch(
  "/:id/lines",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  validateUpdateStockCountLines,
  validate,
  updateStockCountLines
);
router.patch(
  "/:id/submit",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  validateStockCountId,
  validate,
  submitStockCount
);
router.patch(
  "/:id/reconcile",
  protect,
  authorize("branchManager", "admin"),
  validateStockCountId,
  validate,
  reconcileStockCount
);
router.patch(
  "/:id/cancel",
  protect,
  authorize("branchManager", "admin"),
  validateStockCountId,
  validate,
  cancelStockCount
);

export default router;
