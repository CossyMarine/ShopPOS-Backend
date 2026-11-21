// routes/analyticsRoutes.js
import express from "express";
import mongoose from "mongoose";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";
import { responseCache } from "../Middlewares/responseCache.js";
import { getAnalyticsOverview, getCategoryMargin, getDeadStock, getVatReport } from "../controllers/analyticsController.js";
import { getDashboard } from "../controllers/dashboardController.js";
import { getCosts, getDayReport, getTill, getStaff, getAudit } from "../controllers/analyticsOpsController.js";

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

/* ---------- 30-second cache for the heavy long-history views ----------
   These run a product lookup over every item sold in the range, so "This
   Year" and "All" are expensive and every sale triggers a refresh. Shorter
   ranges stay live and uncached. */
const CACHE_TTL_MS = 30_000;

// dashboard: only the two long ranges
const longDashboardRange = (req) => req.query.range === "year" || req.query.range === "all";

// category-margin: the dashboard forwards the period as from/to dates, so
// "long" means a span of ~10 months or more (This Year = 364 days, All = since 2000)
const longDateSpan = (req) => {
  const from = Date.parse(req.query.from);
  const to = Date.parse(req.query.to);
  return Number.isFinite(from) && Number.isFinite(to) && to - from >= 300 * 864e5;
};

/* The dashboard controller already scopes the branch itself. */
router.get(
  "/dashboard",
  responseCache({ ttlMs: CACHE_TTL_MS, when: longDashboardRange }),
  getDashboard
);

/* These read ?branch= straight from the query string, so they need
   sameBranch: Super Admin passes through, everyone else is locked to their
   own branch (an omitted branch is filled in, another branch gets a 403).
   sameBranch runs BEFORE the cache so the cache key always carries the final branch. */
router.get("/overview", validBranch, sameBranch, getAnalyticsOverview);
router.get(
  "/category-margin",
  validBranch,
  sameBranch,
  responseCache({ ttlMs: CACHE_TTL_MS, when: longDateSpan }),
  getCategoryMargin
);
router.get("/dead-stock", validBranch, sameBranch, getDeadStock);

/* VAT detail. Not cached, so flipping the VAT switch in Admin Settings
   takes effect on the next load. Answers { enabled: false } when it is off. */
router.get("/vat", validBranch, sameBranch, getVatReport);

/* Losses, petty cash, day report, till check, staff accountability, audit trail */
router.get("/costs", validBranch, sameBranch, getCosts);
router.get("/day", validBranch, sameBranch, getDayReport);
router.get("/till", validBranch, sameBranch, getTill);
router.get("/staff", validBranch, sameBranch, getStaff);
router.get("/audit", validBranch, sameBranch, getAudit);

export default router;
