// routes/orderRoutes.js
import express from "express";
import { createOrder } from "../controllers/orderController.js";
import { protect, authorize, requireOpenShift } from "../Middlewares/authMiddleware.js";

const router = express.Router();

// Finalizes a checkout: creates the sale, deducts stock FIFO, generates the receipt
router.post("/", protect, authorize("cashier", "branchManager", "admin"), requireOpenShift, createOrder);

export default router;
