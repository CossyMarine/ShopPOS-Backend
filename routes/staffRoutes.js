// routes/staffRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getStaffOverview } from "../controllers/staffController.js";

const router = express.Router();
router.use(protect, authorize("admin", "branchManager"));

router.get("/:userId/overview", getStaffOverview);

export default router;
