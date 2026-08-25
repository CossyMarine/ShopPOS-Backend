// Middlewares/validators/stockTransferValidators.js
import { body, param } from "express-validator";

export const validateCreateStockTransfer = [
  body("fromBranch").isMongoId().withMessage("fromBranch must be a valid id"),
  body("toBranch").isMongoId().withMessage("toBranch must be a valid id"),
  body("note").optional().isString().trim(),
  body("lines").isArray({ min: 1 }).withMessage("lines must be a non-empty array"),
  body("lines.*.product").isMongoId().withMessage("Each line needs a valid product id"),
  body("lines.*.quantitySent").isFloat({ gt: 0 }).withMessage("quantitySent must be greater than 0"),
];

export const validateStockTransferId = [
  param("id").isMongoId().withMessage("Invalid stock transfer id"),
];

export const validateReceiveStockTransfer = [
  param("id").isMongoId().withMessage("Invalid stock transfer id"),
  body("lines").optional().isArray().withMessage("lines must be an array"),
  body("lines.*.product").optional().isMongoId().withMessage("Each line needs a valid product id"),
  body("lines.*.quantityReceived").optional().isFloat({ min: 0 }).withMessage("quantityReceived must be a non-negative number"),
  body("lines.*.discrepancyNote").optional().isString().trim(),
];

export const validateCancelStockTransfer = [
  param("id").isMongoId().withMessage("Invalid stock transfer id"),
  body("reason").optional().isString().trim(),
];
