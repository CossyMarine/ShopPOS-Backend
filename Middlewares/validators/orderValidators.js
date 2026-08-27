import { body } from "express-validator";

export const validateCreateOrder = [
  body("items").isArray({ min: 1 }).withMessage("Cart must have at least one item"),
  body("items.*.lineTotal").isFloat({ min: 0 }).withMessage("Each item needs a valid lineTotal"),
  body("items.*.quantity").isFloat({ gt: 0 }).withMessage("Each item needs a positive quantity"),
  body("branch").notEmpty().withMessage("branch is required").isMongoId().withMessage("branch must be a valid id"),
  body("clientSaleId").optional().isString().trim(),
];

export const validateSyncBatch = [
  body("sales").isArray({ min: 1 }).withMessage("sales must be a non-empty array"),
  body("sales.*.clientSaleId").isString().trim().notEmpty().withMessage("Each queued sale needs a clientSaleId"),
  body("sales.*.items").isArray({ min: 1 }).withMessage("Each queued sale needs at least one item"),
  body("sales.*.branch").isMongoId().withMessage("Each queued sale needs a valid branch id"),
  body("sales.*.soldAt").optional().isISO8601().withMessage("soldAt must be a valid date"),
];
