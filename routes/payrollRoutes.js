// routes/payrollRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { runPayrollForUser, confirmPayslip, listPayslips, getMyPayslips } from "../controllers/payrollController.js";

const router = express.Router();
router.use(protect);

router.get("/mine", getMyPayslips);

router.use(authorize("admin", "branchManager"));
router.get("/", listPayslips);
router.post("/run", runPayrollForUser);
router.post("/:id/confirm", confirmPayslip);

export default router;
