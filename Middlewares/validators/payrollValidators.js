import { body, param } from "express-validator";

const periodFormat = (v) => /^\d{4}-\d{2}$/.test(v);

export const validateRunPayroll = [
  body("userId").isMongoId().withMessage("userId must be a valid id"),
  body("period").custom(periodFormat).withMessage("period must be 'YYYY-MM'"),
];

export const validateRunBulkPayroll = [
  body("period").custom(periodFormat).withMessage("period must be 'YYYY-MM'"),
  body("role").optional().isString(),
  body("branch").optional().isMongoId(),
  body("applyDeductions").optional().isBoolean(),
  body("selectedDeductionIds").optional().isArray(),
];

export const validateConfirmPayslip = [
  param("id").isMongoId().withMessage("Invalid payslip id"),
];

export const validateConfirmBulkPayslips = [
  body("payslipIds").isArray({ min: 1 }).withMessage("payslipIds (array) is required"),
  body("payslipIds.*").isMongoId().withMessage("Each payslip id must be valid"),
];
