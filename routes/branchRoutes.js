// routes/branchRoutes.js
import express from "express";
import { getBranches, createBranch, updateBranch, assignManager, getAllStaff } from "../controllers/branchController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();
const adminOnly = authorize("admin");

router.get("/", protect, adminOnly, getBranches);
router.get("/staff", protect, adminOnly, getAllStaff);
router.post("/", protect, adminOnly, createBranch);
router.put("/:id", protect, adminOnly, updateBranch);
router.patch("/:id/assign-manager", protect, adminOnly, assignManager);

export default router;
