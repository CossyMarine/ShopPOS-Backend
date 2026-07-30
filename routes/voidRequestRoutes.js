// routes/voidRequestRoutes.js
import express from "express";
import {
  getVoidRequests,
  createVoidRequest,
  approveVoidRequest,
  rejectVoidRequest,
} from "../controllers/voidRequestController.js";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", protect, authorize("branchManager", "admin"), getVoidRequests);
router.post("/", protect, authorize("cashier", "branchManager", "admin"), createVoidRequest);
router.patch("/:id/approve", protect, authorize("branchManager", "admin"), approveVoidRequest);
router.patch("/:id/reject", protect, authorize("branchManager", "admin"), rejectVoidRequest);

export default router;
