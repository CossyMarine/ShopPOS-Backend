// controllers/leaveController.js
import LeaveRequest from "../models/LeaveRequest.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Request leave (self-service — any staff/storekeeper/cashier/branchManager)
// @route   POST /api/leave
// @access  Protected
export const requestLeave = async (req, res, next) => {
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
    logStart("leave", "Requesting leave", { user, type, from, to });

    const leave = await LeaveRequest.create({
      user, branch: req.user.branch, type, from, to, reason: reason?.trim() || null,
    });

    const io = req.app.get("io");
    io.to(`branch:${req.user.branch}`).emit("leave:requested", leave);

    logSuccess("leave", "Leave requested", { leaveId: leave._id });
    res.status(201).json(leave);
  } catch (error) {
    next(error);
  }
};

// @desc    Get the logged-in user's own leave requests
// @route   GET /api/leave/mine
// @access  Protected
export const getMyLeave = async (req, res, next) => {
  try {
    logStart("leave", "Loading my leave requests", { user: req.user._id });
    const leaves = await LeaveRequest.find({ user: req.user._id }).sort({ createdAt: -1 });
    logSuccess("leave", "My leave requests loaded", { count: leaves.length });
    res.json(leaves);
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel a still-pending leave request (self-service)
// @route   DELETE /api/leave/:id
// @access  Protected — must be your own, and still pending
export const cancelLeave = async (req, res, next) => {
  try {
    logStart("leave", "Cancelling leave request", { leaveId: req.params.id });

    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) {
      console.warn(`[leave] ⚠️ Leave request not found: ${req.params.id}`);
      return res.status(404).json({ message: "Leave request not found" });
    }
    if (String(leave.user) !== String(req.user._id)) {
      console.warn(`[leave] ⚠️ Ownership mismatch — requester=${req.user._id}, owner=${leave.user}`);
      return res.status(403).json({ message: "This isn't your leave request" });
    }
    if (leave.status !== "pending") {
      console.warn(`[leave] ⚠️ Cannot cancel — status is already "${leave.status}"`);
      return res.status(400).json({ message: "Only pending requests can be cancelled" });
    }
    await leave.deleteOne();
    logSuccess("leave", "Leave request cancelled", { leaveId: req.params.id });
    res.json({ message: "Leave request cancelled" });
  } catch (error) {
    next(error);
  }
};

// @desc    Admin/branchManager — pending leave queue for their branch(es)
// @route   GET /api/leave/pending?branch=
// @access  Protected — admin, branchManager
export const getPendingLeave = async (req, res, next) => {
  try {
    logStart("leave", "Loading pending leave queue", { branch: req.query.branch || "all" });

    const query = { status: "pending" };
    if (req.query.branch) query.branch = req.query.branch;
    const leaves = await LeaveRequest.find(query)
      .populate("user", "fullName role jobTitle")
      .sort({ createdAt: 1 });

    logSuccess("leave", "Pending leave queue loaded", { count: leaves.length });
    res.json(leaves);
  } catch (error) {
    next(error);
  }
};

// @desc    Approve or reject a leave request
// @route   PATCH /api/leave/:id/decide
// @access  Protected — admin, branchManager
export const decideLeave = async (req, res, next) => {
  const { decision, note } = req.body; // decision: "approved" | "rejected"
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ message: "decision must be 'approved' or 'rejected'" });
  }

  try {
    logStart("leave", "Deciding leave request", { leaveId: req.params.id, decision });

    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) {
      console.warn(`[leave] ⚠️ Leave request not found: ${req.params.id}`);
      return res.status(404).json({ message: "Leave request not found" });
    }
    if (leave.status !== "pending") {
      console.warn(`[leave] ⚠️ Already decided — status is "${leave.status}"`);
      return res.status(400).json({ message: "This request has already been decided" });
    }

    leave.status = decision;
    leave.approvedBy = req.user._id;
    leave.decidedAt = new Date();
    leave.decisionNote = note?.trim() || null;
    await leave.save();

    const io = req.app.get("io");
    io.to(`branch:${leave.branch}`).emit("leave:decided", leave);

    logSuccess("leave", "Leave request decided", { leaveId: leave._id, decision });
    res.json(leave);
  } catch (error) {
    next(error);
  }
};
