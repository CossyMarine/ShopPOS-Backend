// controllers/productController.js
import Product from "../models/Product.js";
import { cloudinary } from "../Config/cloudinary.js";
import { deductStockFIFO } from "../utils/productStock.js";

// @desc    Get products for a branch (falls back to name if no image — handled in frontend)
// @route   GET /api/products?branch=<id>
// @access  Public (customer catalog) / Protected (staff, auto-scoped via sameBranch)
export const getProducts = async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.branch) filter.branch = req.query.branch;

    const products = await Product.find(filter)
      .populate("unit", "name abbreviation")
      .sort({ category: 1, name: 1 });

    res.json(products);
  } catch (error) {
    console.error("Error fetching products:", error.message);
    res.status(500).json({ message: "Failed to fetch products" });
  }
};

// @desc    Look up a single product by barcode — powers the cashier scan input
// @route   GET /api/products/barcode/:code?branch=<id>
// @access  Protected — cashier, storekeeper, branchManager, admin
export const getProductByBarcode = async (req, res) => {
  try {
    const filter = { barcode: req.params.code, isActive: true };
    if (req.query.branch) filter.branch = req.query.branch;

    const product = await Product.findOne(filter).populate("unit", "name abbreviation");
    if (!product) return res.status(404).json({ message: "Product not found" });

    res.json(product);
  } catch (error) {
    console.error("Error looking up barcode:", error.message);
    res.status(500).json({ message: "Barcode lookup failed" });
  }
};

// @desc    Upload a product image (falls back to name display if skipped)
// @route   POST /api/products/upload-image
// @access  Protected — storekeeper, branchManager, admin
export const uploadProductImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No image uploaded" });
    res.json({ url: req.file.path, publicId: req.file.filename });
  } catch (error) {
    console.error("Error uploading product image:", error.message);
    res.status(500).json({ message: "Image upload failed" });
  }
};

// @desc    Create a product (storekeeper adds a new item to the catalog)
// @route   POST /api/products
// @access  Protected — storekeeper, branchManager, admin
export const createProduct = async (req, res) => {
  try {
    const { name, barcode, category, unit, sellingPrice, reorderLevel, imageUrl, imagePublicId, branch } = req.body;

    if (!name || !unit || !sellingPrice || !branch) {
      return res.status(400).json({ message: "Name, unit, sellingPrice and branch are required" });
    }

    const product = await Product.create({
      name, barcode: barcode || undefined, category: category || "General",
      unit, sellingPrice, reorderLevel: reorderLevel || 0,
      imageUrl: imageUrl || null, imagePublicId: imagePublicId || null,
      branch, batches: [],
    });

    res.status(201).json(product);
  } catch (error) {
    console.error("Error creating product:", error.message);
    res.status(500).json({ message: "Failed to create product" });
  }
};

// @desc    Update product details (name, price, category, barcode, image)
// @route   PUT /api/products/:id
// @access  Protected — storekeeper, branchManager, admin
export const updateProduct = async (req, res) => {
  try {
    const allowed = ["name", "barcode", "category", "unit", "sellingPrice", "reorderLevel", "imageUrl", "imagePublicId", "isActive"];
    const updates = {};
    allowed.forEach((key) => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });

    const existing = await Product.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: "Product not found" });

    if (updates.imagePublicId !== undefined && existing.imagePublicId && existing.imagePublicId !== updates.imagePublicId) {
      await cloudinary.uploader.destroy(existing.imagePublicId).catch(() => {});
    }

    const product = await Product.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json(product);
  } catch (error) {
    console.error("Error updating product:", error.message);
    res.status(500).json({ message: "Failed to update product" });
  }
};

// @desc    Receive new stock — storekeeper logs a batch with cost + expiry
// @route   POST /api/products/:id/receive-stock
// @access  Protected — storekeeper, branchManager, admin
export const receiveStock = async (req, res) => {
  try {
    const { quantity, costPerUnit, expiryDate, supplierNote } = req.body;
    if (!quantity || costPerUnit === undefined) {
      return res.status(400).json({ message: "quantity and costPerUnit are required" });
    }

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });

    product.batches.push({
      quantity, costPerUnit, expiryDate: expiryDate || null,
      receivedBy: req.user._id, supplierNote: supplierNote || "",
    });
    await product.save();

    res.json(product);
  } catch (error) {
    console.error("Error receiving stock:", error.message);
    res.status(500).json({ message: "Failed to receive stock" });
  }
};

// @desc    Sell/deduct stock FIFO — called internally by the checkout/payment flow
// @route   (not exposed directly — imported by orderController/paymentController)
export const sellProductStock = deductStockFIFO;

// @desc    Delete a product
// @route   DELETE /api/products/:id
// @access  Protected — branchManager, admin
export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    if (product.imagePublicId) await cloudinary.uploader.destroy(product.imagePublicId).catch(() => {});
    res.json({ message: "Product deleted" });
  } catch (error) {
    console.error("Error deleting product:", error.message);
    res.status(500).json({ message: "Failed to delete product" });
  }
};
