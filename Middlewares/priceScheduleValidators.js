// Middlewares/validators/priceScheduleValidators.js
import { body, param } from "express-validator";

export const validateCreatePriceSchedule = [
  body("product").isMongoId().withMessage("product must be a valid id"),
  body("field").optional().isIn(["sellingPrice", "casePrice"]),
  body("newValue").isFloat({ min: 0 }).withMessage("newValue must be a non-negative number"),
  body("effectiveAt").isISO8601().withMessage("effectiveAt must be a valid date"),
];

export const validatePriceScheduleId = [
  param("id").isMongoId().withMessage("Invalid price schedule id"),
];
