import { body } from "express-validator";

export const validateResolveBill = [
  body("billId").notEmpty().withMessage("Bill ID is required").trim(),
  body("identifier").optional().isString().trim(),
];

export const validatePayWithManualTill = [
  body("receiptId").isMongoId().withMessage("receiptId must be a valid id"),
  body("amount").isFloat({ gt: 0 }).withMessage("amount must be a positive number"),
  body("reference").optional().isString().trim(),
];

export const validatePayWithStk = [
  body("receiptId").isMongoId().withMessage("receiptId must be a valid id"),
  body("amount").isFloat({ gt: 0 }).withMessage("amount must be a positive number"),
  body("phone").notEmpty().withMessage("phone is required").trim(),
];

export const validatePayWithReward = [
  body("receiptId").isMongoId().withMessage("receiptId must be a valid id"),
  body("points").optional().isInt({ gt: 0 }).withMessage("points must be a positive integer"),
];

export const validateAdminAddReward = [
  body("identifier").notEmpty().withMessage("Customer email/phone is required").trim(),
  body("amountSpent").isFloat({ gt: 0 }).withMessage("amountSpent must be a positive number"),
];

export const validateAdminPayWithReward = [
  body("identifier").notEmpty().withMessage("Customer email/phone is required").trim(),
  body("receiptId").isMongoId().withMessage("receiptId must be a valid id"),
  body("points").optional().isInt({ gt: 0 }).withMessage("points must be a positive integer"),
];
