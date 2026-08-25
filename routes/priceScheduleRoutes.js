// routes/priceScheduleRoutes.js
import express from "express";
import { createPriceSchedule, getPriceSchedules, cancelPriceSchedule } from "../controllers/priceScheduleController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { validateCreatePriceSchedule, validatePriceScheduleId } from "../Middlewares/validators/priceScheduleValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();

router.post("/", protect, authorize("branchManager", "admin"), validateCreatePriceSchedule, validate, createPriceSchedule);
router.get("/", protect, authorize("storekeeper", "branchManager", "admin"), getPriceSchedules);
router.patch("/:id/cancel", protect, authorize("branchManager", "admin"), validatePriceScheduleId, validate, cancelPriceSchedule);

export default router;
