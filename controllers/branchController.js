// controllers/branchController.js
import Branch from "../models/Branch.js";
import User from "../models/User.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";

// @desc    List all branches — this is the "view all branches" screen for Super Admin
// @route   GET /api/branches
// @access  Protected — admin only
export const getBranches = async (req, res) => {
  try {
    logStart("branch", "Loading branches");
    const branches = await Branch.find().populate("manager", "fullName email phone");
    logSuccess("branch", "Branches loaded", { count: branches.length });
    res.json(branches);
  } catch (error) {
    logError("branch", "Error fetching branches", error);
    res.status(500).json({ message: "Failed to fetch branches" });
  }
};

// @desc    Create a new branch
// @route   POST /api/branches
// @access  Protected — admin only
export const createBranch = async (req, res) => {
  try {
    const { name, address, taxRate } = req.body;
    logStart("branch", "Creating branch", { name, taxRate });

    if (!name) {
      console.warn("[branch] ⚠️ Missing branch name");
      return res.status(400).json({ message: "Branch name is required" });
    }

    const branch = await Branch.create({ name, address: address || "", taxRate: taxRate ?? 16 });

    logSuccess("branch", "Branch created", { branchId: branch._id, name });
    res.status(201).json(branch);
  } catch (error) {
    logError("branch", "Error creating branch", error);
    res.status(500).json({ message: "Failed to create branch" });
  }
};

// @desc    Update branch details (name, address, tax rate, active status)
// @route   PUT /api/branches/:id
// @access  Protected — admin only
export const updateBranch = async (req, res) => {
  try {
    const allowed = ["name", "address", "taxRate", "isActive"];
    const updates = {};
    allowed.forEach((key) => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });

    logStart("branch", "Updating branch", { branchId: req.params.id, updates });

    const branch = await Branch.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!branch) {
      console.warn(`[branch] ⚠️ Branch not found: ${req.params.id}`);
      return res.status(404).json({ message: "Branch not found" });
    }

    logSuccess("branch", "Branch updated", { branchId: branch._id });
    res.json(branch);
  } catch (error) {
    logError("branch", "Error updating branch", error);
    res.status(500).json({ message: "Failed to update branch" });
  }
};

// @desc    Assign a Branch Manager to a branch — also stamps user.role/branch
// @route   PATCH /api/branches/:id/assign-manager
// @access  Protected — admin only
export const assignManager = async (req, res) => {
  try {
    const { userId } = req.body;
    logStart("branch", "Assigning manager", { branchId: req.params.id, userId });

    if (!userId) {
      console.warn("[branch] ⚠️ Missing userId");
      return res.status(400).json({ message: "userId is required" });
    }

    const branch = await Branch.findById(req.params.id);
    if (!branch) {
      console.warn(`[branch] ⚠️ Branch not found: ${req.params.id}`);
      return res.status(404).json({ message: "Branch not found" });
    }

    const user = await User.findById(userId);
    if (!user) {
      console.warn(`[branch] ⚠️ User not found: ${userId}`);
      return res.status(404).json({ message: "User not found" });
    }

    user.role = "branchManager";
    user.branch = branch._id;
    await user.save();

    branch.manager = user._id;
    await branch.save();

    logSuccess("branch", "Manager assigned", { branchId: branch._id, managerId: user._id, managerName: user.fullName });
    res.json({ branch, manager: user });
  } catch (error) {
    logError("branch", "Error assigning manager", error);
    res.status(500).json({ message: "Failed to assign manager" });
  }
};

// @desc    Cross-branch staff directory — every worker, grouped by branch
// @route   GET /api/branches/staff
// @access  Protected — admin only
export const getAllStaff = async (req, res) => {
  try {
    logStart("branch", "Loading cross-branch staff directory");

    const staff = await User.find({ role: { $ne: "customer" } })
      .select("-password")
      .populate("branch", "name")
      .sort({ branch: 1, role: 1, fullName: 1 });

    logSuccess("branch", "Staff directory loaded", { count: staff.length });
    res.json(staff);
  } catch (error) {
    logError("branch", "Error fetching staff", error);
    res.status(500).json({ message: "Failed to fetch staff directory" });
  }
};

// @desc    Get the current logged-in staff member's own branch (name only) —
//          used for things like printed labels/receipts where a non-admin
//          needs their branch name but isn't allowed to list all branches.
// @route   GET /api/branches/mine
// @access  Protected — any authenticated staff member
export const getMyBranch = async (req, res) => {
  try {
    logStart("branch", "Loading own branch", { user: req.user._id });

    if (!req.user.branch) {
      logSuccess("branch", "No branch assigned", { user: req.user._id });
      return res.json(null);
    }
    const branch = await Branch.findById(req.user.branch).select("name");
    if (!branch) {
      console.warn(`[branch] ⚠️ Assigned branch not found: ${req.user.branch}`);
      return res.json(null);
    }

    logSuccess("branch", "Own branch loaded", { branchId: branch._id, name: branch.name });
    res.json({ id: branch._id, name: branch.name });
  } catch (error) {
    logError("branch", "Error fetching own branch", error);
    res.status(500).json({ message: "Failed to fetch branch" });
  }
};
