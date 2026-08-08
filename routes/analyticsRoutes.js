// routes/analyticsRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getAnalyticsOverview } from "../controllers/analyticsController.js";

const router = express.Router();

router.use(protect);
router.use(authorize("admin", "branchManager"));

router.get("/overview", getAnalyticsOverview);

export default router;
