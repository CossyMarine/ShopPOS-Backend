// routes/settingsRoutes.js
import express from "express";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";
import { getSettings, updateSettings, getPublicSettings } from "../controllers/settingsController.js";
import { validateUpdateSettings } from "../Middlewares/validators/settingsValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();

router.get("/public", getPublicSettings);
router.get("/", protect, authorize("admin", "accountant"), requirePermission("settings"), getSettings);
router.patch("/", protect, authorize("admin", "accountant"), requirePermission("settings"), validateUpdateSettings, validate, updateSettings);

export default router;
