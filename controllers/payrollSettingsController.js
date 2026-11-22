// controllers/payrollSettingsController.js
import PayrollSettings from "../models/PayrollSettings.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

export const getPayrollSettings = async (req, res, next) => {
  const branch = req.query.branch || (req.user.isAdmin ? null : req.user.branch);
  try {
    logStart("payrollSettings", "Loading payroll settings", { branch });

    const settings = (await PayrollSettings.findOne({ branch })) || (await PayrollSettings.findOne({ branch: null }));

    logSuccess("payrollSettings", "Payroll settings loaded", { branch, found: Boolean(settings) });
    res.json(settings);
  } catch (error) {
    next(error);
  }
};

const NUM = ["hourlyRate","overtimeMultiplier","dailyRateWeekday","dailyRateWeekend","monthlySalary","commissionRate"];
const SCHED_NUM = ["disburseAfterHours","intervalDays","payDay"];

const pickSettings = (body) => {
  const out = {};
  if (body.wageType) out.wageType = body.wageType;
  if (body.paymentMethod) out.paymentMethod = body.paymentMethod;
  for (const k of NUM) if (body[k] !== undefined && body[k] !== "") out[k] = Number(body[k]);
  if (typeof body.applyStatutoryDeductions === "boolean") out.applyStatutoryDeductions = body.applyStatutoryDeductions;
  if (typeof body.assumeShiftCheck === "boolean") out.assumeShiftCheck = body.assumeShiftCheck;
  if (Array.isArray(body.selectedDeductions)) out.selectedDeductions = body.selectedDeductions;
  const sch = body.schedule || {};
  if (sch.shiftStart) out["schedule.shiftStart"] = sch.shiftStart;
  if (sch.shiftEnd) out["schedule.shiftEnd"] = sch.shiftEnd;
  for (const k of SCHED_NUM) if (sch[k] !== undefined && sch[k] !== "") out[`schedule.${k}`] = Number(sch[k]);
  return out;
};

export const upsertPayrollSettings = async (req, res, next) => {
  const branch = req.body.branch || (req.user.isAdmin ? null : req.user.branch);
  if (branch && !req.user.isAdmin && String(branch) !== String(req.user.branch)) {
    return res.status(403).json({ message: "You can only set defaults for your own branch" });
  }
  try {
    logStart("payrollSettings", "Saving payroll settings", { branch });

    const settings = await PayrollSettings.findOneAndUpdate(
      { branch },
      { $set: { ...pickSettings(req.body), branch, updatedBy: req.user._id } },
      { new: true, upsert: true, runValidators: true }
    );

    logSuccess("payrollSettings", "Payroll settings saved", { branch, settingsId: settings._id });
    res.json(settings);
  } catch (error) {
    next(error);
  }
};
