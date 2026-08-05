// controllers/payrollSettingsController.js
import PayrollSettings from "../models/PayrollSettings.js";

export const getPayrollSettings = async (req, res) => {
  const branch = req.query.branch || (req.user.isAdmin ? null : req.user.branch);
  try {
    const settings = (await PayrollSettings.findOne({ branch })) || (await PayrollSettings.findOne({ branch: null }));
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: "Failed to load payroll settings", error: error.message });
  }
};

export const upsertPayrollSettings = async (req, res) => {
  const branch = req.body.branch || (req.user.isAdmin ? null : req.user.branch);
  if (branch && !req.user.isAdmin && String(branch) !== String(req.user.branch)) {
    return res.status(403).json({ message: "You can only set defaults for your own branch" });
  }
  try {
    const settings = await PayrollSettings.findOneAndUpdate(
      { branch },
      { $set: { ...req.body, branch, updatedBy: req.user._id } },
      { new: true, upsert: true, runValidators: true }
    );
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: "Failed to save payroll settings", error: error.message });
  }
};
