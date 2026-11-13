import { body } from "express-validator";

export const validateUpdateSettings = [
  body("tillNumber").optional().isString().trim(),
  body("tillName").optional().isString().trim(),
  body("whatsappNumber").optional().isString().trim(),
  body("callNumber").optional().isString().trim(),
  body("assumeTableNumberCustomer").optional().isBoolean(),
  body("assumeTableNumberWaiter").optional().isBoolean(),
  body("allowPrintingDuringPayment").optional().isBoolean(),

  body("reward").optional().isObject().withMessage("reward must be an object"),
  body("reward.enabled").optional().isBoolean(),
  body("reward.cashbackPercent").optional().isFloat({ min: 0, max: 100 }).withMessage("cashbackPercent must be between 0 and 100"),
  body("reward.pointValueKes").optional().isFloat({ min: 0 }).withMessage("pointValueKes must be non-negative"),
  body("reward.targetPoints").optional().isFloat({ min: 0 }).withMessage("targetPoints must be non-negative"),
  body("reward.description").optional().isString().trim(),

  body("vat").optional().isObject().withMessage("vat must be an object"),
  body("vat.enabled").optional().isBoolean(),
  body("vat.rate").optional().isFloat({ min: 0, max: 100 }).withMessage("VAT rate must be between 0 and 100"),
  body("vat.priceMode").optional().isIn(["exclusive", "inclusive"]).withMessage("priceMode must be exclusive or inclusive"),
    body("storeName").optional().isString().trim().isLength({ max: 80 }),
  body("currency").optional().isString().trim().isLength({ min: 2, max: 6 }),
  body("timezone").optional().custom((v) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return true; }
    catch { throw new Error("Invalid timezone (use e.g. Africa/Nairobi)"); }
  }),
  body("openHour").optional().isInt({ min: 0, max: 23 }).withMessage("Opening hour must be 0 to 23"),
  body("closeHour").optional().isInt({ min: 0, max: 23 }).withMessage("Closing hour must be 0 to 23"),
];
