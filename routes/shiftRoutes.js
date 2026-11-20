// routes/shiftRoutes.js
import express from "express";
import {
  openShift, getCurrentShift, addPettyCash, getShiftSummary, closeShift,
  getShiftHistory, openShiftForCashier, getShiftStatusForCashier,getShiftsReport,
} from "../controllers/shiftController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.post("/open", protect, openShift);
router.get("/current", protect, getCurrentShift);
router.post("/:id/petty-cash", protect, addPettyCash);
router.get("/:id/summary", protect, getShiftSummary);
router.post("/:id/close", protect, closeShift);

router.post("/cashier/:cashierId/open", protect, authorize("cashier", "branchManager", "admin"), openShiftForCashier);
router.get("/cashier/:cashierId/status", protect, authorize("cashier", "branchManager", "admin"), getShiftStatusForCashier);

router.get("/history/:userId", protect, authorize("admin", "branchManager"), getShiftHistory);

router.get("/", protect, authorize("admin", "branchManager"), sameBranch, getShiftsReport);
export default router;
