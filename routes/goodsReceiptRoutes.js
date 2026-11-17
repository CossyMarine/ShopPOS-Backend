import express from "express";
import { createGoodsReceipt, getGoodsReceipts, getGoodsReceipt } from "../controllers/goodsReceiptController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";

const router = express.Router();
const stockStaff = authorize("admin", "branchManager", "storekeeper");

router.post("/", protect, stockStaff, sameBranch, createGoodsReceipt);
router.get("/", protect, stockStaff, sameBranch, getGoodsReceipts);
router.get("/:id", protect, stockStaff, getGoodsReceipt);

export default router;
