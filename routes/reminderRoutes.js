// routes/reminderRoutes.js
import express from "express";
import { body, param } from "express-validator";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { validate } from "../Middlewares/validate.js";
import {
  getReminders, createReminder, updateReminder, deleteReminder,
} from "../controllers/reminderController.js";

const router = express.Router();
router.use(protect, authorize("admin", "branchManager"));

const fields = [
  body("title").optional().isString().trim().isLength({ min: 1, max: 120 }),
  body("amount").optional({ nullable: true }).isFloat({ min: 0 }),
  body("due").optional().isISO8601(),
  body("repeat").optional().isIn(["none", "weekly", "monthly", "yearly"]),
  body("day").optional({ nullable: true }).isInt({ min: 1, max: 31 }),
  body("snoozeUntil").optional({ nullable: true }).isISO8601(),
  body("done").optional().isBoolean(),
  body("doneAt").optional({ nullable: true }).isISO8601(),
];

router.get("/", getReminders);
router.post("/", body("title").exists(), body("due").exists(), ...fields, validate, createReminder);
router.patch("/:id", param("id").isMongoId(), ...fields, validate, updateReminder);
router.delete("/:id", param("id").isMongoId(), validate, deleteReminder);

export default router;
