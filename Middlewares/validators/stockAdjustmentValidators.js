import { body, param } from "express-validator";

const REASONS = ["damaged", "expired", "stolen", "spillage", "count_correction", "other"];
const PHOTO_REQUIRED_REASONS = ["damaged", "stolen"];

export const validateCreateStockAdjustment = [
  body("productId").isMongoId().withMessage("productId must be a valid id"),
  body("quantity").isFloat({ gt: 0 }).withMessage("quantity must be a positive number"),
  body("reason").isIn(REASONS).withMessage(`reason must be one of: ${REASONS.join(", ")}`),
  body("note").optional().isString().trim(),
  body("photoUrl")
    .if(body("reason").isIn(PHOTO_REQUIRED_REASONS))
    .notEmpty()
    .withMessage("Photo evidence is required for this reason"),
];

export const validateAdjustmentId = [
  param("id").isMongoId().withMessage("Invalid adjustment id"),
];

export const validateRejectStockAdjustment = [
  param("id").isMongoId().withMessage("Invalid adjustment id"),
  body("rejectionNote").optional().isString().trim(),
];
