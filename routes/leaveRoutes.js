// routes/leaveRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import {
  requestLeave, getMyLeave, cancelLeave, getPendingLeave, decideLeave,
} from "../controllers/leaveController.js";

const router = express.Router();
router.use(protect);

router.post("/", requestLeave);
router.get("/mine", getMyLeave);
router.delete("/:id", cancelLeave);

router.get("/pending", authorize("admin", "branchManager"), getPendingLeave);
router.patch("/:id/decide", authorize("admin", "branchManager"), decideLeave);

export default router;
