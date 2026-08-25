import { body } from "express-validator";

export const validateUpsertPayrollSettings = [
  body("branch").optional({ nullable: true }).isMongoId().withMessage("branch must be a valid id"),
  body("wageType").isIn(["hourly", "daily", "monthly"]).withMessage("wageType must be hourly, daily, or monthly"),
  body("hourlyRate").optional().isFloat({ min: 0 }).withMessage("hourlyRate must be a non-negative number"),
  body("overtimeMultiplier").optional().isFloat({ min: 0 }).withMessage("overtimeMultiplier must be a non-negative number"),
  body("dailyRateWeekday").optional().isFloat({ min: 0 }).withMessage("dailyRateWeekday must be a non-negative number"),
  body("dailyRateWeekend").optional().isFloat({ min: 0 }).withMessage("dailyRateWeekend must be a non-negative number"),
  body("monthlySalary").optional().isFloat({ min: 0 }).withMessage("monthlySalary must be a non-negative number"),
  body("commissionRate").optional().isFloat({ min: 0 }).withMessage("commissionRate must be a non-negative number"),
  body("paymentMethod").optional().isIn(["mpesa", "bank", "cash"]).withMessage("paymentMethod must be mpesa, bank, or cash"),
  body("applyStatutoryDeductions").optional().isBoolean().withMessage("applyStatutoryDeductions must be true or false"),
  body("selectedDeductions").optional().isArray().withMessage("selectedDeductions must be an array"),
  body("schedule.shiftStart").optional().isString(),
  body("schedule.shiftEnd").optional().isString(),
  body("schedule.disburseAfterHours").optional().isFloat({ min: 0 }),
  body("schedule.intervalDays").optional().isInt({ min: 1 }),
  body("schedule.payDay").optional().isInt({ min: 1, max: 31 }),
  body("assumeShiftCheck").optional().isBoolean(),
];
