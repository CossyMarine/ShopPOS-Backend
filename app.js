// app.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";

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

dotenv.config();

/* =================================================
   APP
================================================= */
const app = express();

app.set("trust proxy", 1);

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

export default app;
