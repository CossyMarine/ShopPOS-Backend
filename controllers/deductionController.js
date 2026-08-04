// controllers/deductionController.js
import Deduction from "../models/Deduction.js";

export const listDeductions = async (req, res) => {
  try {
    const query = {};
    if (!req.user.isAdmin) query.branch = { $in: [null, req.user.branch] };
    const deductions = await Deduction.find(query)
      .populate("users", "fullName role jobTitle")
      .sort({ createdAt: -1 });
    res.json(deductions);
  } catch (error) {
    res.status(500).json({ message: "Failed to load deductions", error: error.message });
  }
};

export const createDeduction = async (req, res) => {
  const { name, calcType, amount, appliesTo, users, branch } = req.body;

  if (!name || !["fixed", "percentage"].includes(calcType) || amount == null) {
    return res.status(400).json({ message: "name, calcType (fixed|percentage) and amount are required" });
  }
  if (appliesTo === "individual" && (!users || users.length === 0)) {
    return res.status(400).json({ message: "Select at least one staff member for an individual deduction" });
  }

  try {
    const deduction = await Deduction.create({
      name,
      calcType,
      amount,
      appliesTo: appliesTo === "individual" ? "individual" : "all",
      users: appliesTo === "individual" ? users : [],
      branch: req.user.isAdmin ? (branch || null) : req.user.branch,
      createdBy: req.user._id,
    });
    res.status(201).json(deduction);
  } catch (error) {
    res.status(500).json({ message: "Failed to create deduction", error: error.message });
  }
};

export const updateDeduction = async (req, res) => {
  try {
    const deduction = await Deduction.findById(req.params.id);
    if (!deduction) return res.status(404).json({ message: "Deduction not found" });
    if (!req.user.isAdmin && deduction.branch && String(deduction.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: "You can only manage your own branch's deductions" });
    }

    const { name, calcType, amount, appliesTo, users, isActive } = req.body;
    if (name !== undefined) deduction.name = name;
    if (calcType !== undefined) deduction.calcType = calcType;
    if (amount !== undefined) deduction.amount = amount;
    if (appliesTo !== undefined) deduction.appliesTo = appliesTo;
    if (users !== undefined) deduction.users = users;
    if (isActive !== undefined) deduction.isActive = isActive;

    await deduction.save();
    res.json(deduction);
  } catch (error) {
    res.status(500).json({ message: "Failed to update deduction", error: error.message });
  }
};

export const deleteDeduction = async (req, res) => {
  try {
    const deduction = await Deduction.findById(req.params.id);
    if (!deduction) return res.status(404).json({ message: "Deduction not found" });
    if (!req.user.isAdmin && deduction.branch && String(deduction.branch) !== String(req.user.branch)) {
      return res.status(403).json({ message: "You can only manage your own branch's deductions" });
    }
    await deduction.deleteOne();
    res.json({ message: "Deduction removed" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete deduction", error: error.message });
  }
};
