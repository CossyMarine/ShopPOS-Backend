// routes/customerRoutes.js
import express from "express";
import { getCatalog, getFavorites, toggleFavorite } from "../controllers/customerController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/catalog", getCatalog); // public
router.get("/favorites", protect, authorize("customer"), getFavorites);
router.post("/favorites/:productId/toggle", protect, authorize("customer"), toggleFavorite);

export default router;
