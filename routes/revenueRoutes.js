// routes/revenueRoutes.js
import express from "express";
import { getTodayRevenue, getRevenueSummary, getDashboardStats } from "../controllers/revenueController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/today", getTodayRevenue);
router.get("/summary", protect, authorize("admin", "branchManager"), getRevenueSummary);
router.get("/dashboard-stats", protect, authorize("admin", "branchManager"), getDashboardStats);

export default router;
