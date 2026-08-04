// routes/deductionRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { listDeductions, createDeduction, updateDeduction, deleteDeduction } from "../controllers/deductionController.js";

const router = express.Router();
router.use(protect, authorize("admin", "branchManager"));

router.get("/", listDeductions);
router.post("/", createDeduction);
router.patch("/:id", updateDeduction);
router.delete("/:id", deleteDeduction);

export default router;
