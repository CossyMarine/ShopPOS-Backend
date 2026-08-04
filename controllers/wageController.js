// controllers/wageController.js
import WageProfile from "../models/WageProfile.js";
import User from "../models/User.js";
import { getAvailableDeductionsForUser } from "./payrollController.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";

export const getWageProfile = async (req, res) => {
  try {
    logStart("wage", "Loading wage profile", { userId: req.params.userId });
    const profile = await WageProfile.findOne({ user: req.params.userId });
    logSuccess("wage", "Wage profile loaded", { userId: req.params.userId, found: Boolean(profile) });
    res.json(profile);
  } catch (error) {
    logError("wage", "Error loading wage profile", error);
    res.status(500).json({ message: "Failed to load wage profile", error: error.message });
  }
};

// NEW — the "menu" of deductions to show under the Apply statutory
// deductions toggle: the built-in statutory levy + every custom Deduction
// that applies to this specific user. Frontend defaults to all of them
// selected when selectedDeductions is empty on the profile.
export const getDeductionOptions = async (req, res) => {
  try {
    logStart("wage", "Loading deduction options", { userId: req.params.userId });

    const user = await User.findById(req.params.userId);
    if (!user) {
      console.warn(`[wage] ⚠️ User not found: ${req.params.userId}`);
      return res.status(404).json({ message: "User not found" });
    }
    if (!req.user.isAdmin && String(user.branch) !== String(req.user.branch)) {
      console.warn(`[wage] ⚠️ Branch mismatch — requester=${req.user.branch}, target=${user.branch}`);
      return res.status(403).json({ message: "You can only view deductions for your own branch" });
    }
    const options = await getAvailableDeductionsForUser(user);

    logSuccess("wage", "Deduction options loaded", { userId: req.params.userId, count: options.length });
    res.json(options);
  } catch (error) {
    logError("wage", "Error loading deduction options", error);
    res.status(500).json({ message: "Failed to load deduction options", error: error.message });
  }
};

export const upsertWageProfile = async (req, res) => {
  const { userId } = req.params;
  const {
    wageType, hourlyRate, overtimeMultiplier,
    dailyRateWeekday, dailyRateWeekend,
    monthlySalary, commissionRate,
    paymentMethod, applyStatutoryDeductions,
    selectedDeductions, // NEW
    nextPayoutDate,     // NEW
    noSalary,
  } = req.body;

  if (!["hourly", "daily", "monthly"].includes(wageType)) {
    return res.status(400).json({ message: "wageType must be hourly, daily, or monthly" });
  }

  try {
    logStart("wage", "Saving wage profile", { userId, wageType, noSalary: !!noSalary });

    const user = await User.findById(userId);
    if (!user) {
      console.warn(`[wage] ⚠️ User not found: ${userId}`);
      return res.status(404).json({ message: "User not found" });
    }
    if (!user.branch) {
      console.warn(`[wage] ⚠️ User ${userId} has no assigned branch`);
      return res.status(400).json({ message: "This user has no assigned branch" });
    }

    if (!req.user.isAdmin && String(user.branch) !== String(req.user.branch)) {
      console.warn(`[wage] ⚠️ Branch mismatch — requester=${req.user.branch}, target=${user.branch}`);
      return res.status(403).json({ message: "You can only manage wages for your own branch" });
    }

    const update = {
      branch: user.branch, wageType,
      hourlyRate: hourlyRate || 0,
      overtimeMultiplier: overtimeMultiplier || 1.5,
      dailyRateWeekday: dailyRateWeekday || 0,
      dailyRateWeekend: dailyRateWeekend || 0,
      monthlySalary: monthlySalary || 0,
      commissionRate: commissionRate || 0,
      paymentMethod: paymentMethod || "mpesa",
      applyStatutoryDeductions: applyStatutoryDeductions !== false,
      selectedDeductions: Array.isArray(selectedDeductions) ? selectedDeductions : [],
      nextPayoutDate: nextPayoutDate || null,
      noSalary: !!noSalary,
      updatedBy: req.user._id,
    };

    const profile = await WageProfile.findOneAndUpdate(
      { user: userId },
      { $set: update, $setOnInsert: { user: userId } },
      { new: true, upsert: true, runValidators: true }
    );

    logSuccess("wage", "Wage profile saved", { userId, wageType, profileId: profile._id });
    res.json(profile);
  } catch (error) {
    logError("wage", "Error saving wage profile", error);
    res.status(500).json({ message: "Failed to save wage profile", error: error.message });
  }
};

export const listWageProfiles = async (req, res) => {
  try {
    logStart("wage", "Loading wage profiles", { branch: req.query.branch || "own" });

    const query = {};
    if (req.query.branch) query.branch = req.query.branch;
    else if (!req.user.isAdmin) query.branch = req.user.branch;

    const profiles = await WageProfile.find(query).populate("user", "fullName role jobTitle isActive");

    logSuccess("wage", "Wage profiles loaded", { count: profiles.length });
    res.json(profiles);
  } catch (error) {
    logError("wage", "Error loading wage profiles", error);
    res.status(500).json({ message: "Failed to load wage profiles", error: error.message });
  }
};
