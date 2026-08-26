// routes/analyticsRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getAnalyticsOverview, getCategoryMargin, getDeadStock } from "../controllers/analyticsController.js";

const router = express.Router();

router.use(protect);
router.use(authorize("admin", "branchManager"));

router.get("/overview", getAnalyticsOverview);
router.get("/category-margin", getCategoryMargin);
router.get("/dead-stock", getDeadStock);

export default router;
