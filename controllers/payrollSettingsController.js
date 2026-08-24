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

export const upsertPayrollSettings = async (req, res, next) => {
  const branch = req.body.branch || (req.user.isAdmin ? null : req.user.branch);
  if (branch && !req.user.isAdmin && String(branch) !== String(req.user.branch)) {
    return res.status(403).json({ message: "You can only set defaults for your own branch" });
  }
  try {
    logStart("payrollSettings", "Saving payroll settings", { branch });

    const settings = await PayrollSettings.findOneAndUpdate(
      { branch },
      { $set: { ...req.body, branch, updatedBy: req.user._id } },
      { new: true, upsert: true, runValidators: true }
    );

    logSuccess("payrollSettings", "Payroll settings saved", { branch, settingsId: settings._id });
    res.json(settings);
  } catch (error) {
    next(error);
  }
};
