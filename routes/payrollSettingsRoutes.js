// routes/payrollSettingsRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getPayrollSettings, upsertPayrollSettings } from "../controllers/payrollSettingsController.js";

const router = express.Router();
router.use(protect, authorize("admin", "branchManager"));
router.get("/", getPayrollSettings);
router.put("/", upsertPayrollSettings);

export default router;
