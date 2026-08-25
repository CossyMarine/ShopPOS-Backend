import mongoose from "mongoose";
import dotenv from "dotenv";
import * as Sentry from "@sentry/node";
import app from "./app.js";
import http from "http";
import { Server } from "socket.io";

dotenv.config();

/* ========================================
   🛡️ SENTRY
   Must be initialized before the process-level handlers below, so they
   can report to it, and before anything else runs.
======================================== */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: "production",
});

/* ========================================
   🛑 PROCESS-LEVEL SAFETY NETS
   Must be registered before anything else runs. Without these, a
   rejected promise or thrown error that nothing catches can silently
   kill the backend mid-shift with no trace.
======================================== */
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  // Logged, not exited — an unhandled rejection alone shouldn't take
  // down a live POS.
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  Sentry.captureException(err);
  // This means a bug escaped every try/catch and every promise handler —
  // the process state is no longer trustworthy, so exit and let your
  // process manager (pm2/systemd/Render) restart it clean.
  process.exit(1);
});

/* ========================================
   🗄️ CONNECT TO MONGODB
======================================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.log("❌ MongoDB error:", err));

const PORT = process.env.PORT || 5000;

/* ========================================
   🌐 CREATE HTTP SERVER
======================================== */
const server = http.createServer(app);

/* ========================================
   🔌 SOCKET.IO SETUP
======================================== */
const ALLOWED_ORIGINS = [
  "https://shop-pos-frontend-azure.vercel.app",
  "http://localhost:3000", // local dev
];

export const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PATCH"],
  },
});

/* Make io accessible in routes/controllers via req.app.get("io") */
app.set("io", io);

/* ========================================
   🔗 SOCKET CONNECTION — ROOMS
   Rooms let a screen subscribe only to what it needs, e.g. a
   kitchen display joins "kitchen" instead of hearing every event.
======================================== */
io.on("connection", (socket) => {
  console.log("🔌 New client connected:", socket.id);

  socket.on("join_room", (room) => {
    socket.join(room);
  });

  socket.on("leave_room", (room) => {
    socket.leave(room);
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

/* ========================================
   🚀 START SERVER
======================================== */
server.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
