// routes/productRoutes.js
import express from "express";
import {
  getProducts, getProductByBarcode, uploadProductImage,
  createProduct, updateProduct, deleteProduct, receiveStock,
} from "../controllers/productController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";
import { uploadProductImage as uploadProductImageMiddleware } from "../Config/cloudinary.js";

const router = express.Router();

const stockStaff = authorize("admin", "branchManager", "storekeeper");
const sellStaff   = authorize("admin", "branchManager", "cashier", "storekeeper");

router.get("/", protect, sellStaff, sameBranch, getProducts);          // catalog — cashier + others read
router.get("/barcode/:code", protect, sellStaff, sameBranch, getProductByBarcode);

router.post("/upload-image", protect, stockStaff, uploadProductImageMiddleware.single("image"), uploadProductImage);
router.post("/", protect, stockStaff, sameBranch, createProduct);
router.put("/:id", protect, stockStaff, sameBranch, updateProduct);
router.post("/:id/receive-stock", protect, stockStaff, sameBranch, receiveStock);
router.delete("/:id", protect, authorize("admin", "branchManager"), sameBranch, deleteProduct);

export default router;
