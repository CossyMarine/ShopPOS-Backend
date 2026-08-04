// controllers/attendanceController.js
import Attendance from "../models/Attendance.js";

// @desc    Clock in for the logged-in user (storekeeper/staff)
// @route   POST /api/attendance/clock-in
// @access  Protected — storekeeper, staff, branchManager
export const clockIn = async (req, res) => {
  const user = req.user._id;

  if (!req.user.branch) {
    return res.status(400).json({ message: "Your account has no assigned branch" });
  }

  try {
    const existing = await Attendance.findOne({ user, status: "open" });
    if (existing) {
      return res.status(400).json({ message: "You're already clocked in", record: existing });
    }

    const record = await Attendance.create({ user, branch: req.user.branch });

    const io = req.app.get("io");
    io.to(`branch:${record.branch}`).emit("attendance:clockedIn", record);

    res.status(201).json(record);
  } catch (error) {
    console.error("Error clocking in:", error.message);
    res.status(500).json({ message: "Failed to clock in", error: error.message });
  }
};

// @desc    Clock out — closes the user's own open record
// @route   POST /api/attendance/clock-out
// @access  Protected
export const clockOut = async (req, res) => {
  const { notes } = req.body;
  const user = req.user._id;

  try {
    const record = await Attendance.findOne({ user, status: "open" });
    if (!record) {
      return res.status(400).json({ message: "You're not currently clocked in" });
    }

    record.clockOutAt = new Date();
    record.notes = notes || null;
    record.status = "closed";
    await record.save();

    const io = req.app.get("io");
    io.to(`branch:${record.branch}`).emit("attendance:clockedOut", record);

    res.json(record);
  } catch (error) {
    console.error("Error clocking out:", error.message);
    res.status(500).json({ message: "Failed to clock out", error: error.message });
  }
};

// @desc    Get the logged-in user's own open attendance record, or null
// @route   GET /api/attendance/current
// @access  Protected
export const getCurrentAttendance = async (req, res) => {
  try {
    const record = await Attendance.findOne({ user: req.user._id, status: "open" });
    res.json(record);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch attendance status", error: error.message });
  }
};

// @desc    Admin/branchManager — attendance history for one user, filterable by date
// @route   GET /api/attendance/history/:userId?from=&to=
// @access  Protected — admin, branchManager
export const getAttendanceHistory = async (req, res) => {
  const { userId } = req.params;
  const { from, to } = req.query;
  try {
    const query = { user: userId };
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    const records = await Attendance.find(query).sort({ createdAt: -1 });
    res.json(records);
  } catch (error) {
    res.status(500).json({ message: "Failed to load attendance history", error: error.message });
  }
};

// @desc    Admin/branchManager — everyone currently clocked in at a branch (live view)
// @route   GET /api/attendance/on-shift?branch=
// @access  Protected — admin, branchManager
export const getOnShiftNow = async (req, res) => {
  try {
    const query = { status: "open" };
    if (req.query.branch) query.branch = req.query.branch;
    const records = await Attendance.find(query).populate("user", "fullName role jobTitle");
    res.json(records);
  } catch (error) {
    res.status(500).json({ message: "Failed to load on-shift staff", error: error.message });
  }
};
