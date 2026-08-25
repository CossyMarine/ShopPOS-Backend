// routes/payrollSettingsRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getPayrollSettings, upsertPayrollSettings } from "../controllers/payrollSettingsController.js";
import { validateUpsertPayrollSettings } from "../Middlewares/validators/payrollSettingsValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();
router.use(protect, authorize("admin", "branchManager"));
router.get("/", getPayrollSettings);
router.put("/", validateUpsertPayrollSettings, validate, upsertPayrollSettings);

export default router;
