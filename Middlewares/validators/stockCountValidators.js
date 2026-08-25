// Middlewares/validators/stockCountValidators.js
import { body, param } from "express-validator";

export const validateStartStockCount = [
  body("branch").isMongoId().withMessage("branch must be a valid id"),
  body("category").optional().isString().trim(),
  body("note").optional().isString().trim(),
];

export const validateStockCountId = [
  param("id").isMongoId().withMessage("Invalid stock count id"),
];

export const validateUpdateStockCountLines = [
  param("id").isMongoId().withMessage("Invalid stock count id"),
  body("lines").isArray({ min: 1 }).withMessage("lines must be a non-empty array"),
  body("lines.*.product").isMongoId().withMessage("Each line needs a valid product id"),
  body("lines.*.countedQty").isFloat({ min: 0 }).withMessage("countedQty must be a non-negative number"),
];
