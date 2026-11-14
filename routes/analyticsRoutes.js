// routes/analyticsRoutes.js
import express from "express";
import mongoose from "mongoose";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";
import { getAnalyticsOverview, getCategoryMargin, getDeadStock } from "../controllers/analyticsController.js";
import { getDashboard } from "../controllers/dashboardController.js";

const router = express.Router();

router.use(protect);
router.use(authorize("admin", "branchManager"));

/* Reject a malformed ?branch= with a clean 400 instead of letting
   `new ObjectId(branch)` throw and surface as a 500. */
const validBranch = (req, res, next) => {
  const { branch } = req.query;
  if (branch && !mongoose.isValidObjectId(branch)) {
    return res.status(400).json({ message: "Invalid branch id" });
  }
  next();
};

/* The dashboard controller already scopes the branch itself. */
router.get("/dashboard", getDashboard);

/* These three read ?branch= straight from the query string, so they need
   sameBranch: Super Admin passes through, everyone else is locked to their
   own branch (an omitted branch is filled in, another branch gets a 403). */
router.get("/overview", validBranch, sameBranch, getAnalyticsOverview);
router.get("/category-margin", validBranch, sameBranch, getCategoryMargin);
router.get("/dead-stock", validBranch, sameBranch, getDeadStock);

export default router;
