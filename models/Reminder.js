// models/Reminder.js
import mongoose from "mongoose";

const reminderSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, default: null, min: 0 },
    due: { type: Date, required: true },
    repeat: { type: String, enum: ["none", "weekly", "monthly", "yearly"], default: "none" },
    // Original day-of-month, so a "31st" monthly reminder doesn't drift after a short month
    day: { type: Number, default: null, min: 1, max: 31 },
    snoozeUntil: { type: Date, default: null },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Reminder", reminderSchema);
