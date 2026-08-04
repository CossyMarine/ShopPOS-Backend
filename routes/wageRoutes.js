// routes/wageRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getWageProfile, upsertWageProfile, listWageProfiles } from "../controllers/wageController.js";

const router = express.Router();
router.use(protect, authorize("admin", "branchManager"));

router.get("/", listWageProfiles);
router.get("/:userId", getWageProfile);
router.put("/:userId", upsertWageProfile);

export default router;
