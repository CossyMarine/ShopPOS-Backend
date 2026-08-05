// routes/payrollRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import {
  runPayrollForUser,
  confirmPayslip,
  listPayslips,
  getMyPayslips,
  runBulkPayroll,      // NEW
  confirmBulkPayslips, // NEW
  getPayrollSummary,   // NEW
  getPayrollDueToday,
  getPayrollInsight,
} from "../controllers/payrollController.js";

const router = express.Router();
router.use(protect);

router.get("/mine", getMyPayslips);

router.use(authorize("admin", "branchManager"));
router.get("/", listPayslips);
router.get("/summary", getPayrollSummary);      // NEW — Est. Monthly Payroll stat
router.post("/run", runPayrollForUser);
router.post("/run-bulk", runBulkPayroll);       // NEW — global/filtered payout run
router.post("/:id/confirm", confirmPayslip);
router.post("/confirm-bulk", confirmBulkPayslips); // NEW — bulk disburse
router.get("/due-today", getPayrollDueToday);
router.get("/insight", getPayrollInsight);

export default router;
