// controllers/branchController.js
import Branch from "../models/Branch.js";
import User from "../models/User.js";

// @desc    List all branches — this is the "view all branches" screen for Super Admin
// @route   GET /api/branches
// @access  Protected — admin only
export const getBranches = async (req, res) => {
  try {
    const branches = await Branch.find().populate("manager", "fullName email phone");
    res.json(branches);
  } catch (error) {
    console.error("Error fetching branches:", error.message);
    res.status(500).json({ message: "Failed to fetch branches" });
  }
};

// @desc    Create a new branch
// @route   POST /api/branches
// @access  Protected — admin only
export const createBranch = async (req, res) => {
  try {
    const { name, address, taxRate } = req.body;
    if (!name) return res.status(400).json({ message: "Branch name is required" });

    const branch = await Branch.create({ name, address: address || "", taxRate: taxRate ?? 16 });
    res.status(201).json(branch);
  } catch (error) {
    console.error("Error creating branch:", error.message);
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

    const branch = await Branch.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    res.json(branch);
  } catch (error) {
    console.error("Error updating branch:", error.message);
    res.status(500).json({ message: "Failed to update branch" });
  }
};

// @desc    Assign a Branch Manager to a branch — also stamps user.role/branch
// @route   PATCH /api/branches/:id/assign-manager
// @access  Protected — admin only
export const assignManager = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    const branch = await Branch.findById(req.params.id);
    if (!branch) return res.status(404).json({ message: "Branch not found" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.role = "branchManager";
    user.branch = branch._id;
    await user.save();

    branch.manager = user._id;
    await branch.save();

    res.json({ branch, manager: user });
  } catch (error) {
    console.error("Error assigning manager:", error.message);
    res.status(500).json({ message: "Failed to assign manager" });
  }
};

// @desc    Cross-branch staff directory — every worker, grouped by branch
// @route   GET /api/branches/staff
// @access  Protected — admin only
export const getAllStaff = async (req, res) => {
  try {
    const staff = await User.find({ role: { $ne: "customer" } })
      .select("-password")
      .populate("branch", "name")
      .sort({ branch: 1, role: 1, fullName: 1 });
    res.json(staff);
  } catch (error) {
    console.error("Error fetching staff:", error.message);
    res.status(500).json({ message: "Failed to fetch staff directory" });
  }
};
