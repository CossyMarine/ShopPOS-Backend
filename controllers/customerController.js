// controllers/customerController.js
import Product from "../models/Product.js";
import User from "../models/User.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Public product catalog for the Customer Portal — no stock/cost
//          internals, just what a shopper needs to browse and add to wishlist
// @route   GET /api/customer/catalog?branch=
// @access  Public
export const getCatalog = async (req, res, next) => {
  try {
    logStart("customer", "Loading catalog", { branch: req.query.branch || "all" });

    const filter = { isActive: true };
    if (req.query.branch) filter.branch = req.query.branch;

    const products = await Product.find(filter)
      .select("name category sellingPrice imageUrl barcode branch")
      .sort({ category: 1, name: 1 });

    logSuccess("customer", "Catalog loaded", { count: products.length });
    res.json(products);
  } catch (error) {
    next(error);
  }
};

// @desc    Logged-in customer's wishlist product ids
// @route   GET /api/customer/favorites
// @access  Protected — customer
export const getFavorites = async (req, res, next) => {
  try {
    logStart("customer", "Loading favorites", { user: req.user._id });

    const user = await User.findById(req.user._id).populate({
      path: "favorites",
      select: "name category sellingPrice imageUrl branch",
      match: { isActive: true },
    });

    logSuccess("customer", "Favorites loaded", { user: req.user._id, count: user.favorites.length });
    res.json(user.favorites);
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle a product in/out of the logged-in customer's wishlist
// @route   POST /api/customer/favorites/:productId/toggle
// @access  Protected — customer
export const toggleFavorite = async (req, res, next) => {
  try {
    const { productId } = req.params;
    logStart("customer", "Toggling favorite", { user: req.user._id, productId });

    const user = await User.findById(req.user._id);

    const idx = user.favorites.findIndex((f) => String(f) === productId);
    const isFavorite = idx === -1;
    if (isFavorite) user.favorites.push(productId);
    else user.favorites.splice(idx, 1);

    await user.save();

    logSuccess("customer", "Favorite toggled", { user: req.user._id, productId, isFavorite });
    res.json({ isFavorite, favoritesCount: user.favorites.length });
  } catch (error) {
    next(error);
  }
};
