// models/Attendance.js
import mongoose from "mongoose";

const attendanceSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    status: { type: String, enum: ["open", "closed"], default: "open" },

    clockOutAt: { type: Date, default: null },
    notes:      { type: String, default: null },
  },
  { timestamps: true } // createdAt doubles as clockInAt
);

// One open attendance record per user at a time
attendanceSchema.index({ user: 1, status: 1 });

export default mongoose.model("Attendance", attendanceSchema);
