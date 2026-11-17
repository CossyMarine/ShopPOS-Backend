import express from "express";
import { getSuppliers, createSupplier, updateSupplier, deleteSupplier } from "../controllers/supplierController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";

const router = express.Router();
const stockStaff = authorize("admin", "branchManager", "storekeeper");

router.get("/", protect, stockStaff, sameBranch, getSuppliers);
router.post("/", protect, stockStaff, sameBranch, createSupplier);
router.put("/:id", protect, stockStaff, updateSupplier);
router.delete("/:id", protect, stockStaff, deleteSupplier);

export default router;
