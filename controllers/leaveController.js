// controllers/leaveController.js
import LeaveRequest from "../models/LeaveRequest.js";

// @desc    Request leave (self-service — any staff/storekeeper/cashier/branchManager)
// @route   POST /api/leave
// @access  Protected
export const requestLeave = async (req, res) => {
  const { type, from, to, reason } = req.body;
  const user = req.user._id;

  if (!["paid", "unpaid"].includes(type)) {
    return res.status(400).json({ message: "type must be 'paid' or 'unpaid'" });
  }
  if (!from || !to || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
    return res.status(400).json({ message: "Valid from/to dates are required" });
  }
  if (new Date(from) > new Date(to)) {
    return res.status(400).json({ message: "'from' must be before 'to'" });
  }
  if (!req.user.branch) {
    return res.status(400).json({ message: "Your account has no assigned branch" });
  }

  try {
    const leave = await LeaveRequest.create({
      user, branch: req.user.branch, type, from, to, reason: reason?.trim() || null,
    });

    const io = req.app.get("io");
    io.to(`branch:${req.user.branch}`).emit("leave:requested", leave);

    res.status(201).json(leave);
  } catch (error) {
    console.error("Error requesting leave:", error.message);
    res.status(500).json({ message: "Failed to request leave", error: error.message });
  }
};

// @desc    Get the logged-in user's own leave requests
// @route   GET /api/leave/mine
// @access  Protected
export const getMyLeave = async (req, res) => {
  try {
    const leaves = await LeaveRequest.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: "Failed to load leave requests", error: error.message });
  }
};

// @desc    Cancel a still-pending leave request (self-service)
// @route   DELETE /api/leave/:id
// @access  Protected — must be your own, and still pending
export const cancelLeave = async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: "Leave request not found" });
    if (String(leave.user) !== String(req.user._id)) {
      return res.status(403).json({ message: "This isn't your leave request" });
    }
    if (leave.status !== "pending") {
      return res.status(400).json({ message: "Only pending requests can be cancelled" });
    }
    await leave.deleteOne();
    res.json({ message: "Leave request cancelled" });
  } catch (error) {
    res.status(500).json({ message: "Failed to cancel leave request", error: error.message });
  }
};

// @desc    Admin/branchManager — pending leave queue for their branch(es)
// @route   GET /api/leave/pending?branch=
// @access  Protected — admin, branchManager
export const getPendingLeave = async (req, res) => {
  try {
    const query = { status: "pending" };
    if (req.query.branch) query.branch = req.query.branch;
    const leaves = await LeaveRequest.find(query)
      .populate("user", "fullName role jobTitle")
      .sort({ createdAt: 1 });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ message: "Failed to load pending leave", error: error.message });
  }
};

// @desc    Approve or reject a leave request
// @route   PATCH /api/leave/:id/decide
// @access  Protected — admin, branchManager
export const decideLeave = async (req, res) => {
  const { decision, note } = req.body; // decision: "approved" | "rejected"
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ message: "decision must be 'approved' or 'rejected'" });
  }

  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: "Leave request not found" });
    if (leave.status !== "pending") {
      return res.status(400).json({ message: "This request has already been decided" });
    }

    leave.status = decision;
    leave.approvedBy = req.user._id;
    leave.decidedAt = new Date();
    leave.decisionNote = note?.trim() || null;
    await leave.save();

    const io = req.app.get("io");
    io.to(`branch:${leave.branch}`).emit("leave:decided", leave);

    res.json(leave);
  } catch (error) {
    res.status(500).json({ message: "Failed to decide leave request", error: error.message });
  }
};
