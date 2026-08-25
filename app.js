// app.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import helmet from "helmet";

// Middlewares
import { requestId } from "./Middlewares/requestId.js";
import { notFoundHandler, errorHandler } from "./Middlewares/errorHandler.js";

// Routes
import authRoutes from "./routes/authRoutes.js";
import productRoutes from "./routes/productRoutes.js";
import branchRoutes from "./routes/branchRoutes.js";
import receiptRoutes from "./routes/receiptRoutes.js";
import shiftRoutes from "./routes/shiftRoutes.js";
import voidRequestRoutes from "./routes/voidRequestRoutes.js";
import revenueRoutes from "./routes/revenueRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import walletRoutes from "./routes/walletRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import customerRoutes from "./routes/customerRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import attendanceRoutes from "./routes/attendanceRoutes.js";
import leaveRoutes from "./routes/leaveRoutes.js";
import payrollRoutes from "./routes/payrollRoutes.js"
import wageRoutes from "./routes/wageRoutes.js";
import deductionRoutes from "./routes/deductionRoutes.js";
import staffRoutes from "./routes/staffRoutes.js";
import aiInsightsRoutes from "./routes/aiInsightsRoutes.js";
import payrollSettingsRoutes from "./routes/payrollSettingsRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import stockAdjustmentRoutes from "./routes/stockAdjustmentRoutes.js";
import stockCountRoutes from "./routes/stockCountRoutes.js";

dotenv.config();

/* =================================================
   APP
================================================= */
const app = express();

app.set("trust proxy", 1);

/* Request ID — attaches req.requestId to every request, before anything
   else touches it, so it's available to morgan, controllers, and the
   error handler for end-to-end tracing of a single transaction. */
app.use(requestId);

/* Helmet — sets security-related HTTP headers (nosniff, frame-ancestors,
   HSTS, hides X-Powered-By, etc). Applied early, before routes. */
app.use(helmet());

/* CORS — credentials:true is required so the httpOnly auth cookie is sent */
const ALLOWED_ORIGINS = [
  "https://shop-pos-frontend-azure.vercel.app",
  "http://localhost:3000", // local dev
  "http://localhost:5173", // vite dev
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  })
);

/* Body parser */
app.use(express.json());

/* Cookie parser — required to read the httpOnly auth cookie */
app.use(cookieParser());

/* Request logger — prints method/path/status/response-time to the console
   for every request, e.g. "GET /api/products 200 15ms" */
app.use(morgan("dev"));

/* Health check */
app.get("/", (req, res) => {
  res.json({ status: "Babylon POS backend running" });
});

/* =================================================
   ROUTES
================================================= */
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/receipts", receiptRoutes);
app.use("/api/shifts", shiftRoutes);
app.use("/api/void-requests", voidRequestRoutes);
app.use("/api/revenue", revenueRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/leave", leaveRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/wages", wageRoutes);
app.use("/api/deductions", deductionRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/ai-insights", aiInsightsRoutes);
app.use("/api/payroll-settings", payrollSettingsRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/stock-adjustments", stockAdjustmentRoutes);
app.use("/api/stock-counts", stockCountRoutes);

/* =================================================
   404 + ERROR HANDLING
   Must be registered LAST — after every route above — so they only
   catch what nothing else handled: unmatched routes, and any error
   passed to next(err) or thrown in an async route handler.
================================================= */
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
