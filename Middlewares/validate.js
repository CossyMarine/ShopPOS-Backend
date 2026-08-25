// Middlewares/validate.js
import { validationResult } from "express-validator";
import { badRequest } from "../utils/AppError.js";

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const details = errors.array().reduce((acc, e) => {
    acc[e.path] = e.msg;
    return acc;
  }, {});

  next(badRequest("Validation failed", details));
};
