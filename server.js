import mongoose from "mongoose";
import dotenv from "dotenv";
import * as Sentry from "@sentry/node";
import app from "./app.js";
import http from "http";
import { Server } from "socket.io";
import cron from "node-cron";
import jwt from "jsonwebtoken";
import { applyDuePriceSchedules } from "./utils/applyScheduledPriceChanges.js";
import { getDisplayState } from "./utils/displayState.js";
import { checkMpesaConfig } from "./utils/mpesa.js";
import User from "./models/User.js";

// The date helpers (utils/dateHelpers.js) work out "today", "this week" and
// "this month" from the server's own clock and assume it is Nairobi time.
// Render servers run on UTC, which shifted every "today" range by 3 hours, so
// sales made between 00:00 and 03:00 landed on the wrong day. Kenya has no
// daylight saving, so pinning the zone is safe.
process.env.TZ = "Africa/Nairobi";

dotenv.config();
checkMpesaConfig();

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
   Keep this list in sync with ALLOWED_ORIGINS in app.js.

   Sockets connect straight to this server (Vercel rewrites don't proxy
   websockets), so the first-party auth cookie is NOT sent with them.
   Instead a signed-in client fetches a short-lived ticket through the
   normal /api route (GET /api/socket/ticket) and passes it in the
   handshake: io(url, { auth: { ticket } }). No cookies, so no
   `credentials: true` is needed here.
======================================== */
const ALLOWED_ORIGINS = [
  "https://shop-pos-frontend-azure.vercel.app",
  "http://localhost:3000", // local dev
  "http://localhost:5173", // vite dev
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
   🔐 SOCKET AUTH
   - Valid ticket   -> socket.data.user is set; may join its branch room.
   - Bad ticket     -> connection refused.
   - No ticket      -> connects anonymously but can join NO rooms. The
                       Customer Display is the one anonymous client: it
                       authenticates itself with its own ticket via
                       "display:join" below.
======================================== */
io.use(async (socket, next) => {
  const ticket = socket.handshake.auth?.ticket;
  if (!ticket) return next();

  try {
    const d = jwt.verify(ticket, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (d.scope !== "socket") throw new Error("wrong scope");

    const user = await User.findById(d.id).select("isAdmin isActive branch");
    if (!user || !user.isActive) throw new Error("inactive or missing user");

    socket.data.user = {
      id: String(user._id),
      isAdmin: !!user.isAdmin,
      branch: user.branch ? String(user.branch) : null,
    };
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

/* ========================================
   ⏰ SCHEDULED PRICE CHANGES
   Runs every minute — catches any price schedule whose effective time has
   arrived. getProducts also does a lazy catch-up on every catalog load, so
   this cron is really just for accuracy when nobody happens to be shopping
   at the exact minute a price is due to change.
======================================== */
cron.schedule("* * * * *", () => {
  applyDuePriceSchedules(io).catch((err) => {
    console.error("❌ Failed to apply scheduled price changes:", err);
    Sentry.captureException(err);
  });
});

/* ========================================
   🔗 SOCKET CONNECTION — ROOMS
   Rooms let a screen subscribe only to what it needs, e.g. a
   kitchen display joins "kitchen" instead of hearing every event.

   Customer Display rooms ("display:<cashierId>") are NOT joinable via
   join_room — they need a short-lived ticket issued to a signed-in
   Display (GET /api/display/socket-ticket).
======================================== */
io.on("connection", (socket) => {
  console.log("🔌 New client connected:", socket.id);

  // Every signed-in socket also gets a private room of its own, so a bill can be
  // pushed to its customer without broadcasting it to everyone.
  if (socket.data.user) socket.join(`user:${socket.data.user.id}`);

  // Only signed-in sockets can join, and only a "branch:<id>" room: their
  // own branch (admins: any branch). Everything else is silently ignored.
  socket.on("join_room", (room) => {
    const u = socket.data.user;
    if (!u || typeof room !== "string") return;

    const m = /^branch:([a-f0-9]{24})$/i.exec(room);
    if (!m) return;

    if (u.isAdmin || u.branch === m[1]) socket.join(room);
  });

  socket.on("display:join", async ({ ticket } = {}) => {
    try {
      const d = jwt.verify(ticket, process.env.JWT_SECRET, { algorithms: ["HS256"] });
      if (d.scope !== "display-socket") throw new Error("wrong scope");
      socket.join(`display:${d.id}`);
      socket.emit("display:state", await getDisplayState(d.id));
    } catch {
      socket.emit("display:auth_error");
    }
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
