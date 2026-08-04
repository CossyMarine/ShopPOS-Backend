// routes/aiInsightsRoutes.js
import express from "express";
import { runStoreAudit } from "../controllers/aiInsightsController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/audit", protect, authorize("admin", "branchManager"), runStoreAudit);

export default router;
