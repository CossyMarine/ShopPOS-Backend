import { body, param } from "express-validator";

export const validateReceiptId = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
];

export const validatePayReceipt = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
  body("amountPaid").isFloat({ gt: 0 }).withMessage("amountPaid must be a positive number"),
];

export const validatePayCashAndTill = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
  body("cashAmount").isFloat({ min: 0 }).withMessage("cashAmount must be a non-negative number"),
];

export const validatePayCombo = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
  body("cashAmount").optional().isFloat({ min: 0 }).withMessage("cashAmount must be a non-negative number"),
  body("tillAmount").optional().isFloat({ min: 0 }).withMessage("tillAmount must be a non-negative number"),
  body("rewardAmount").optional().isFloat({ min: 0 }).withMessage("rewardAmount must be a non-negative number"),
  body("rewardIdentifier").optional().isString().trim(),
];

export const validateInitiateMpesaPayment = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
  body("phone").notEmpty().withMessage("M-Pesa phone number is required").trim(),
  body("cashAmount").optional().isFloat({ min: 0 }).withMessage("cashAmount must be a non-negative number"),
];

export const validateAddItemsToReceipt = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
  body("items").isArray({ min: 1 }).withMessage("At least one item is required"),
  body("items.*.productName").notEmpty().withMessage("Each item needs a productName"),
  body("items.*.quantity").isFloat({ gt: 0 }).withMessage("Each item needs a positive quantity"),
  body("items.*.unitPrice").isFloat({ min: 0 }).withMessage("Each item needs a valid unitPrice"),
];
