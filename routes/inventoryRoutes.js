// routes/inventoryRoutes.js
import express from "express";
import { getUnits, createUnit, deleteUnit } from "../controllers/inventoryController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/units", protect, authorize("admin", "branchManager", "storekeeper", "cashier"), getUnits);
router.post("/units", protect, authorize("admin", "branchManager", "storekeeper"), createUnit);
router.delete("/units/:id", protect, authorize("admin"), deleteUnit);

export default router;
