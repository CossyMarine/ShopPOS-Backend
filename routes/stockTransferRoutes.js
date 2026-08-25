// routes/stockTransferRoutes.js
import express from "express";
import {
  createStockTransfer,
  getStockTransfers,
  getStockTransferById,
  dispatchStockTransfer,
  receiveStockTransfer,
  cancelStockTransfer,
} from "../controllers/stockTransferController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import {
  validateCreateStockTransfer,
  validateStockTransferId,
  validateReceiveStockTransfer,
  validateCancelStockTransfer,
} from "../Middlewares/validators/stockTransferValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();

router.post(
  "/",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  validateCreateStockTransfer,
  validate,
  createStockTransfer
);

router.get("/", protect, authorize("storekeeper", "branchManager", "admin"), getStockTransfers);

router.get(
  "/:id",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  validateStockTransferId,
  validate,
  getStockTransferById
);

router.patch(
  "/:id/dispatch",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  validateStockTransferId,
  validate,
  dispatchStockTransfer
);

router.patch(
  "/:id/receive",
  protect,
  authorize("storekeeper", "branchManager", "admin"),
  validateReceiveStockTransfer,
  validate,
  receiveStockTransfer
);

router.patch(
  "/:id/cancel",
  protect,
  authorize("branchManager", "admin"),
  validateCancelStockTransfer,
  validate,
  cancelStockTransfer
);

export default router;
