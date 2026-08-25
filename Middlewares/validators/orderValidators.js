import { body } from "express-validator";

export const validateCreateOrder = [
  body("items").isArray({ min: 1 }).withMessage("Cart must have at least one item"),
  body("items.*.lineTotal").isFloat({ min: 0 }).withMessage("Each item needs a valid lineTotal"),
  body("items.*.quantity").isFloat({ gt: 0 }).withMessage("Each item needs a positive quantity"),
  body("branch").notEmpty().withMessage("branch is required").isMongoId().withMessage("branch must be a valid id"),
];
