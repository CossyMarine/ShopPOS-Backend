// routes/attendanceRoutes.js
import express from "express";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";
import {
  clockIn,
  clockOut,
  getCurrentAttendance,
  getAttendanceHistory,
  getOnShiftNow,
} from "../controllers/attendanceController.js";

const router = express.Router();

router.use(protect);

router.post("/clock-in", authorize("storekeeper", "staff", "branchManager"), clockIn);
router.post("/clock-out", authorize("storekeeper", "staff", "branchManager"), clockOut);
router.get("/current", getCurrentAttendance);

router.get("/on-shift", authorize("admin", "branchManager"), sameBranch, getOnShiftNow);
router.get("/history/:userId", authorize("admin", "branchManager"), getAttendanceHistory);

export default router;
