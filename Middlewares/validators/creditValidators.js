import { body, param } from "express-validator";

export const validatePayOnCredit = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
  body("customerName").isString().trim().notEmpty().withMessage("Customer name is required").isLength({ max: 80 }),
  body("customerPhone").optional({ values: "falsy" }).isString().trim().isLength({ max: 20 }),
  body("dueDate").optional({ values: "falsy" }).isString(),
];

export const validateSettleCredit = [
  param("id").isMongoId().withMessage("Invalid credit id"),
  body("amount").isFloat({ gt: 0 }).withMessage("amount must be a positive number"),
  body("method").isIn(["cash", "manual_till", "mpesa_till"]).withMessage("Invalid payment method"),
  body("reference").optional({ values: "falsy" }).isString().trim().isLength({ max: 60 }),
];
