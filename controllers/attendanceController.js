// controllers/attendanceController.js
import Attendance from "../models/Attendance.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";

// @desc    Clock in for the logged-in user (storekeeper/staff)
// @route   POST /api/attendance/clock-in
// @access  Protected — storekeeper, staff, branchManager
export const clockIn = async (req, res) => {
  const user = req.user._id;

  if (!req.user.branch) {
    return res.status(400).json({ message: "Your account has no assigned branch" });
  }

  try {
    logStart("attendance", "Clocking in", { user });

    const existing = await Attendance.findOne({ user, status: "open" });
    if (existing) {
      console.warn(`[attendance] ⚠️ User ${user} already clocked in`);
      return res.status(400).json({ message: "You're already clocked in", record: existing });
    }

    const record = await Attendance.create({ user, branch: req.user.branch });

    const io = req.app.get("io");
    io.to(`branch:${record.branch}`).emit("attendance:clockedIn", record);

    logSuccess("attendance", "Clocked in", { user, recordId: record._id });
    res.status(201).json(record);
  } catch (error) {
    logError("attendance", "Error clocking in", error);
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
    logStart("attendance", "Clocking out", { user });

    const record = await Attendance.findOne({ user, status: "open" });
    if (!record) {
      console.warn(`[attendance] ⚠️ User ${user} is not clocked in`);
      return res.status(400).json({ message: "You're not currently clocked in" });
    }

    record.clockOutAt = new Date();
    record.notes = notes || null;
    record.status = "closed";
    await record.save();

    const io = req.app.get("io");
    io.to(`branch:${record.branch}`).emit("attendance:clockedOut", record);

    const hoursWorked = +(((record.clockOutAt - record.createdAt) / 3600000).toFixed(2));
    logSuccess("attendance", "Clocked out", { user, recordId: record._id, hoursWorked });
    res.json(record);
  } catch (error) {
    logError("attendance", "Error clocking out", error);
    res.status(500).json({ message: "Failed to clock out", error: error.message });
  }
};

// @desc    Get the logged-in user's own open attendance record, or null
// @route   GET /api/attendance/current
// @access  Protected
export const getCurrentAttendance = async (req, res) => {
  try {
    logStart("attendance", "Fetching current attendance", { user: req.user._id });
    const record = await Attendance.findOne({ user: req.user._id, status: "open" });
    logSuccess("attendance", "Current attendance fetched", { user: req.user._id, found: Boolean(record) });
    res.json(record);
  } catch (error) {
    logError("attendance", "Error fetching attendance status", error);
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
    logStart("attendance", "Loading attendance history", { userId, from, to });

    const query = { user: userId };
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    const records = await Attendance.find(query).sort({ createdAt: -1 });

    logSuccess("attendance", "Attendance history loaded", { userId, count: records.length });
    res.json(records);
  } catch (error) {
    logError("attendance", "Error loading attendance history", error);
    res.status(500).json({ message: "Failed to load attendance history", error: error.message });
  }
};

// @desc    Admin/branchManager — everyone currently clocked in at a branch (live view)
// @route   GET /api/attendance/on-shift?branch=
// @access  Protected — admin, branchManager
export const getOnShiftNow = async (req, res) => {
  try {
    logStart("attendance", "Loading on-shift staff", { branch: req.query.branch || "all" });

    const query = { status: "open" };
    if (req.query.branch) query.branch = req.query.branch;
    const records = await Attendance.find(query).populate("user", "fullName role jobTitle");

    logSuccess("attendance", "On-shift staff loaded", { count: records.length });
    res.json(records);
  } catch (error) {
    logError("attendance", "Error loading on-shift staff", error);
    res.status(500).json({ message: "Failed to load on-shift staff", error: error.message });
  }
};
