import express from "express";
import { getCredits, getCreditSummary, settleCredit } from "../controllers/creditController.js";
import { protect, authorize, sameBranch } from "../Middlewares/authMiddleware.js";
import { validateSettleCredit } from "../Middlewares/validators/creditValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();
const staff = authorize("admin", "branchManager");

router.get("/summary", protect, staff, sameBranch, getCreditSummary);
router.get("/", protect, staff, sameBranch, getCredits);
router.post("/:id/settle", protect, staff, validateSettleCredit, validate, settleCredit);

export default router;
