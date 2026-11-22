import { body } from "express-validator";

export const validateUpsertPayrollSettings = [
  body("branch").optional({ nullable: true }).isMongoId().withMessage("branch must be a valid id"),
  body("wageType").isIn(["hourly", "daily", "monthly"]).withMessage("wageType must be hourly, daily, or monthly"),
  body("hourlyRate").optional({ values: "falsy" }).isFloat({ min: 0 }).withMessage("hourlyRate must be a non-negative number"),
  body("overtimeMultiplier").optional({ values: "falsy" }).isFloat({ min: 0 }).withMessage("overtimeMultiplier must be a non-negative number"),
  body("dailyRateWeekday").optional({ values: "falsy" }).isFloat({ min: 0 }).withMessage("dailyRateWeekday must be a non-negative number"),
  body("dailyRateWeekend").optional({ values: "falsy" }).isFloat({ min: 0 }).withMessage("dailyRateWeekend must be a non-negative number"),
  body("monthlySalary").optional({ values: "falsy" }).isFloat({ min: 0 }).withMessage("monthlySalary must be a non-negative number"),
  body("commissionRate").optional({ values: "falsy" }).isFloat({ min: 0 }).withMessage("commissionRate must be a non-negative number"),
  body("paymentMethod").optional({ values: "falsy" }).isIn(["mpesa", "bank", "cash"]).withMessage("paymentMethod must be mpesa, bank, or cash"),
  body("applyStatutoryDeductions").optional().isBoolean().withMessage("applyStatutoryDeductions must be true or false"),
  body("selectedDeductions").optional().isArray().withMessage("selectedDeductions must be an array"),
  body("schedule.shiftStart").optional({ values: "falsy" }).isString(),
  body("schedule.shiftEnd").optional({ values: "falsy" }).isString(),
  body("schedule.disburseAfterHours").optional({ values: "falsy" }).isFloat({ min: 0 }),
  body("schedule.intervalDays").optional({ values: "falsy" }).isInt({ min: 1 }),
  body("schedule.payDay").optional({ values: "falsy" }).isInt({ min: 1, max: 31 }),
  body("assumeShiftCheck").optional().isBoolean(),
];
