// routes/promotionRoutes.js
import express from "express";
import { createPromotion, getPromotions, updatePromotion, deletePromotion } from "../controllers/promotionController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { validateCreatePromotion, validatePromotionId, validateUpdatePromotion } from "../Middlewares/validators/promotionValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();

router.post("/", protect, authorize("branchManager", "admin"), validateCreatePromotion, validate, createPromotion);
router.get("/", protect, authorize("storekeeper", "cashier", "branchManager", "admin"), getPromotions);
router.put("/:id", protect, authorize("branchManager", "admin"), validateUpdatePromotion, validate, updatePromotion);
router.delete("/:id", protect, authorize("admin"), validatePromotionId, validate, deletePromotion);

export default router;
