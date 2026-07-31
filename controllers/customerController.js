// controllers/customerController.js
import Product from "../models/Product.js";
import User from "../models/User.js";

// @desc    Public product catalog for the Customer Portal — no stock/cost
//          internals, just what a shopper needs to browse and add to wishlist
// @route   GET /api/customer/catalog?branch=
// @access  Public
export const getCatalog = async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.branch) filter.branch = req.query.branch;

    const products = await Product.find(filter)
      .select("name category sellingPrice imageUrl barcode branch")
      .sort({ category: 1, name: 1 });

    res.json(products);
  } catch (error) {
    console.error("Error fetching catalog:", error.message);
    res.status(500).json({ message: "Failed to fetch catalog" });
  }
};

// @desc    Logged-in customer's wishlist product ids
// @route   GET /api/customer/favorites
// @access  Protected — customer
export const getFavorites = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate({
      path: "favorites",
      select: "name category sellingPrice imageUrl branch",
      match: { isActive: true },
    });
    res.json(user.favorites);
  } catch (error) {
    console.error("Error fetching favorites:", error.message);
    res.status(500).json({ message: "Failed to fetch favorites" });
  }
};

// @desc    Toggle a product in/out of the logged-in customer's wishlist
// @route   POST /api/customer/favorites/:productId/toggle
// @access  Protected — customer
export const toggleFavorite = async (req, res) => {
  try {
    const { productId } = req.params;
    const user = await User.findById(req.user._id);

    const idx = user.favorites.findIndex((f) => String(f) === productId);
    const isFavorite = idx === -1;
    if (isFavorite) user.favorites.push(productId);
    else user.favorites.splice(idx, 1);

    await user.save();
    res.json({ isFavorite, favoritesCount: user.favorites.length });
  } catch (error) {
    console.error("Error toggling favorite:", error.message);
    res.status(500).json({ message: "Failed to update favorites" });
  }
};
