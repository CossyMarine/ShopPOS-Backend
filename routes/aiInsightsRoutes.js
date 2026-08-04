// routes/aiInsightsRoutes.js
import express from "express";
import { runStoreAudit, listGeminiModels } from "../controllers/aiInsightsController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/audit", protect, authorize("admin", "branchManager"), runStoreAudit);
router.get("/list-models", protect, authorize("admin", "branchManager"), listGeminiModels);

export default router;
