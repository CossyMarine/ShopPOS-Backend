// controllers/wageController.js
import WageProfile from "../models/WageProfile.js";
import User from "../models/User.js";

// @desc    Get a user's wage profile (admin/branchManager only — never self-service,
//          this is compensation data, not something staff read about themselves here)
// @route   GET /api/wages/:userId
// @access  Protected — admin, branchManager
export const getWageProfile = async (req, res) => {
  try {
    const profile = await WageProfile.findOne({ user: req.params.userId });
    res.json(profile); // null if not yet configured — frontend treats that as "unset"
  } catch (error) {
    res.status(500).json({ message: "Failed to load wage profile", error: error.message });
  }
};

// @desc    Create or update a user's wage profile
// @route   PUT /api/wages/:userId
// @access  Protected — admin, branchManager
export const upsertWageProfile = async (req, res) => {
  const { userId } = req.params;
  const {
    wageType, hourlyRate, overtimeMultiplier,
    dailyRateWeekday, dailyRateWeekend,
    monthlySalary, commissionRate,
    paymentMethod, applyStatutoryDeductions,
  } = req.body;

  if (!["hourly", "daily", "monthly"].includes(wageType)) {
    return res.status(400).json({ message: "wageType must be hourly, daily, or monthly" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.branch) return res.status(400).json({ message: "This user has no assigned branch" });

    // branchManager can only set wages for their own branch's staff
    if (!req.user.isAdmin && String(user.branch) !== String(req.user.branch)) {
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
      updatedBy: req.user._id,
    };

    const profile = await WageProfile.findOneAndUpdate(
      { user: userId },
      { $set: update, $setOnInsert: { user: userId } },
      { new: true, upsert: true, runValidators: true }
    );

    res.json(profile);
  } catch (error) {
    console.error("Error saving wage profile:", error.message);
    res.status(500).json({ message: "Failed to save wage profile", error: error.message });
  }
};

// @desc    List every wage profile for a branch (used by the payroll run screen)
// @route   GET /api/wages?branch=
// @access  Protected — admin, branchManager
export const listWageProfiles = async (req, res) => {
  try {
    const query = {};
    if (req.query.branch) query.branch = req.query.branch;
    else if (!req.user.isAdmin) query.branch = req.user.branch;

    const profiles = await WageProfile.find(query).populate("user", "fullName role jobTitle isActive");
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ message: "Failed to load wage profiles", error: error.message });
  }
};
