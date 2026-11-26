import { body, param } from "express-validator";

const CREDIT_METHODS = ["cash", "manual_till", "mpesa_till"];

export const validatePayOnCredit = [
  param("id").isMongoId().withMessage("Invalid receipt id"),
  body("customerName").isString().trim().notEmpty().withMessage("Customer name is required").isLength({ max: 80 }),
  body("customerPhone").optional({ values: "falsy" }).isString().trim().isLength({ max: 20 }),
  body("dueDate").optional({ values: "falsy" }).isString(),
];

export const validateSettleCredit = [
  param("id").isMongoId().withMessage("Invalid credit id"),
  body("amount").isFloat({ gt: 0 }).withMessage("amount must be a positive number"),
  body("method").isIn(CREDIT_METHODS).withMessage("Invalid payment method"),
  body("reference").optional({ values: "falsy" }).isString().trim().isLength({ max: 60 }),
];

export const validateSettleMine = [
  body("creditId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid credit id"),
  body("customerName").optional({ values: "falsy" }).isString().trim().isLength({ max: 80 }),
  body().custom((b) => {
    if (!b.creditId && !String(b.customerName || "").trim()) {
      throw new Error("creditId or customerName is required");
    }
    return true;
  }),
  body("payments").isArray({ min: 1, max: 6 }).withMessage("Add at least one payment"),
  body("payments.*.method").isIn(CREDIT_METHODS).withMessage("Invalid payment method"),
  body("payments.*.amount").isFloat({ gt: 0 }).withMessage("Each amount must be positive"),
  body("payments.*.reference").optional({ values: "falsy" }).isString().trim().isLength({ max: 60 }),
];
