import express from "express";
import {
  getCredits, getCreditSummary, settleCredit,
  getMyCustomers, getMyCredits, settleMine,getCreditCustomers, getCreditCustomer, settleCreditCustomer,
} from "../controllers/creditController.js";
import { protect, authorize, sameBranch, requireOpenShift } from "../Middlewares/authMiddleware.js";
import { validateSettleCredit, validateSettleMine, getCreditCustomers } from "../Middlewares/validators/creditValidators.js";
import { validate } from "../Middlewares/validate.js";

const router = express.Router();
const staff = authorize("admin", "branchManager");
const posStaff = authorize("cashier", "branchManager", "admin");

router.get("/customers", protect, staff, sameBranch, getCreditCustomers);
router.get("/customer", protect, staff, sameBranch, getCreditCustomer);
router.post("/customer/settle", protect, staff, sameBranch, validateSettleCustomer, validate, settleCreditCustomer);
// Cashier: only their own credits (must stay above "/:id" routes)
router.get("/mine/customers", protect, posStaff, getMyCustomers);
router.get("/mine", protect, posStaff, getMyCredits);
router.post("/mine/settle", protect, posStaff, requireOpenShift, validateSettleMine, validate, settleMine);

// Manager / admin
router.get("/summary", protect, staff, sameBranch, getCreditSummary);
router.get("/", protect, staff, sameBranch, getCredits);
router.post("/:id/settle", protect, staff, validateSettleCredit, validate, settleCredit);

export default router;
