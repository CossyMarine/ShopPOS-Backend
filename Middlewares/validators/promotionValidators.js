// Middlewares/validators/promotionValidators.js
import { body, param } from "express-validator";

export const validateCreatePromotion = [
  body("name").isString().trim().notEmpty().withMessage("name is required"),
  body("type").isIn(["percent_off", "flat_off"]).withMessage("type must be percent_off or flat_off"),
  body("value").isFloat({ gt: 0 }).withMessage("value must be greater than 0"),
  body("scope").isIn(["product", "category"]).withMessage("scope must be product or category"),
  body("products").optional().isArray(),
  body("products.*").optional().isMongoId(),
  body("category").optional().isString().trim(),
  body("branch").optional({ nullable: true }).isMongoId(),
  body("startDate").isISO8601().withMessage("startDate must be a valid date"),
  body("endDate").isISO8601().withMessage("endDate must be a valid date"),
  body("notes").optional().isString().trim(),
];

export const validatePromotionId = [
  param("id").isMongoId().withMessage("Invalid promotion id"),
];

export const validateUpdatePromotion = [
  param("id").isMongoId().withMessage("Invalid promotion id"),
  body("type").optional().isIn(["percent_off", "flat_off"]),
  body("value").optional().isFloat({ gt: 0 }),
  body("scope").optional().isIn(["product", "category"]),
  body("startDate").optional().isISO8601(),
  body("endDate").optional().isISO8601(),
  body("isActive").optional().isBoolean(),
];
