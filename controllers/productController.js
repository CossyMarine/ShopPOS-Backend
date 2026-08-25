// controllers/productController.js
import Product from "../models/Product.js";
import { cloudinary } from "../Config/cloudinary.js";
import { deductStockFIFO } from "../utils/productStock.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Get products for a branch (falls back to name if no image — handled in frontend)
// @route   GET /api/products?branch=<id>
// @access  Public (customer catalog) / Protected (staff, auto-scoped via sameBranch)
export const getProducts = async (req, res, next) => {
  try {
    logStart("product", "Loading products", { branch: req.query.branch || "all" });

    const filter = { isActive: true };
    if (req.query.branch) filter.branch = req.query.branch;

    const products = await Product.find(filter)
      .populate("unit", "name abbreviation")
      .sort({ category: 1, name: 1 });

    // Cashiers sell strictly at sellingPrice/casePrice — those are set by
    // storekeeper/branchManager/admin via updateProduct. Batch-level cost
    // data (costPerUnit, costPerCase) reveals profit margins and has no
    // business being on a cashier's screen, so it's stripped for them.
    // currentStock is a virtual derived from batches, computed first via
    // toObject({ virtuals: true }) before batches gets removed.
    const isCashier = req.user?.role === "cashier";
    const payload = products.map((p) => {
      const obj = p.toObject({ virtuals: true });
      if (isCashier) delete obj.batches;
      return obj;
    });

    logSuccess("product", "Products loaded", { count: payload.length, strippedBatches: isCashier });
    res.json(payload);
  } catch (error) {
    next(error);
  }
};

// @desc    Look up a single product by barcode — powers the cashier scan input.
//          Matches either the each barcode or the case barcode.
// @route   GET /api/products/barcode/:code?branch=<id>
// @access  Protected — cashier, storekeeper, branchManager, admin
export const getProductByBarcode = async (req, res, next) => {
  try {
    logStart("product", "Looking up barcode", { code: req.params.code, branch: req.query.branch });

    const filter = {
      isActive: true,
      $or: [{ barcode: req.params.code }, { caseBarcode: req.params.code }],
    };
    if (req.query.branch) filter.branch = req.query.branch;

    const product = await Product.findOne(filter).populate("unit", "name abbreviation");
    if (!product) {
      console.warn(`[product] ⚠️ No product found for barcode: ${req.params.code}`);
      return res.status(404).json({ message: "Product not found" });
    }

    // Same cost-price stripping as getProducts — cashier only ever needs
    // sellingPrice/casePrice to ring up an item, never the cost batches.
    const payload = product.toObject({ virtuals: true });
    if (req.user?.role === "cashier") delete payload.batches;

    logSuccess("product", "Barcode matched", { code: req.params.code, productId: product._id, name: product.name });
    res.json(payload);
  } catch (error) {
    next(error);
  }
};

// @desc    Upload a product image (falls back to name display if skipped)
// @route   POST /api/products/upload-image
// @access  Protected — storekeeper, branchManager, admin
export const uploadProductImage = async (req, res, next) => {
  try {
    logStart("product", "Uploading product image");

    if (!req.file) {
      console.warn("[product] ⚠️ No file present on request — check multer middleware / field name");
      return res.status(400).json({ message: "No image uploaded" });
    }

    logSuccess("product", "Product image uploaded", { url: req.file.path, publicId: req.file.filename });
    res.json({ url: req.file.path, publicId: req.file.filename });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a product (storekeeper adds a new item to the catalog)
// @route   POST /api/products
// @access  Protected — storekeeper, branchManager, admin
export const createProduct = async (req, res, next) => {
  try {
    const {
      name, barcode, category, unit, sellingPrice, casePrice, reorderLevel,
      packSize, caseLabel, caseBarcode,
      imageUrl, imagePublicId, branch, vatClass,
    } = req.body;

    logStart("product", "Creating product", { name, branch, sellingPrice });

    if (!name || !unit || !sellingPrice || !branch) {
      console.warn("[product] ⚠️ Missing required field(s) on create");
      return res.status(400).json({ message: "Name, unit, sellingPrice and branch are required" });
    }

    const resolvedPackSize = packSize ? Math.max(1, Math.round(Number(packSize))) : 1;

    const product = await Product.create({
      name, barcode: barcode || undefined, category: category || "General",
      unit, sellingPrice, reorderLevel: reorderLevel || 0,
      packSize: resolvedPackSize,
      caseLabel: resolvedPackSize > 1 ? (caseLabel || "Carton") : "Carton",
      caseBarcode: caseBarcode || null,
      casePrice: resolvedPackSize > 1 && casePrice ? Number(casePrice) : null,
      imageUrl: imageUrl || null, imagePublicId: imagePublicId || null,
      vatClass: vatClass || "standard",
      branch, batches: [],
    });

    logSuccess("product", "Product created", { productId: product._id, name });
    res.status(201).json(product);
  } catch (error) {
    next(error);
  }
};

// @desc    Update product details (name, price, category, barcode, image, pack size, case price)
// @route   PUT /api/products/:id
// @access  Protected — storekeeper, branchManager, admin
export const updateProduct = async (req, res, next) => {
  try {
    const allowed = [
      "name", "barcode", "category", "unit", "sellingPrice", "casePrice", "reorderLevel",
      "packSize", "caseLabel", "caseBarcode", "imageUrl", "imagePublicId", "isActive", "vatClass",
    ];
    const updates = {};
    allowed.forEach((key) => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });

    logStart("product", "Updating product", { productId: req.params.id, fields: Object.keys(updates) });

    if (updates.packSize !== undefined) {
      updates.packSize = Math.max(1, Math.round(Number(updates.packSize) || 1));
    }
    if (updates.packSize === 1) updates.casePrice = null;

    const existing = await Product.findById(req.params.id);
    if (!existing) {
      console.warn(`[product] ⚠️ Product not found: ${req.params.id}`);
      return res.status(404).json({ message: "Product not found" });
    }

    if (updates.imagePublicId !== undefined && existing.imagePublicId && existing.imagePublicId !== updates.imagePublicId) {
      console.log(`[product] → Replacing image — destroying old Cloudinary asset ${existing.imagePublicId}`);
      await cloudinary.uploader.destroy(existing.imagePublicId).catch((err) => {
        console.warn(`[product] ⚠️ Failed to destroy old Cloudinary asset ${existing.imagePublicId}:`, err.message);
      });
    }

    const product = await Product.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });

    logSuccess("product", "Product updated", { productId: product._id });
    res.json(product);
  } catch (error) {
    next(error);
  }
};

// @desc    Receive new stock — storekeeper logs a batch with cost + expiry.
//          Accepts either loose units or, if the product has a packSize > 1,
//          whole cases — the storekeeper types in whatever the supplier
//          invoice actually says (cartons @ price/carton, or pieces @
//          price/piece), and this always normalizes to per-each cost
//          before it's stored, so FIFO deduction and profit math never
//          have to think about cases again.
// @route   POST /api/products/:id/receive-stock
// @body    { quantity, costPerUnit, receivedAs?: "case"|"each", expiryDate?, supplierNote? }
// @access  Protected — storekeeper, branchManager, admin
export const receiveStock = async (req, res, next) => {
  try {
    const { quantity, costPerUnit, receivedAs, expiryDate, supplierNote } = req.body;
    logStart("product", "Receiving stock", { productId: req.params.id, quantity, costPerUnit, receivedAs });

    if (!quantity || costPerUnit === undefined) {
      console.warn("[product] ⚠️ Missing quantity or costPerUnit on receive-stock");
      return res.status(400).json({ message: "quantity and costPerUnit are required" });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      console.warn(`[product] ⚠️ Product not found: ${req.params.id}`);
      return res.status(404).json({ message: "Product not found" });
    }

    const packSize = product.packSize || 1;
    const mode = receivedAs === "case" ? "case" : "each";

    if (mode === "case" && packSize <= 1) {
      console.warn(`[product] ⚠️ ${product.name} has no case size — cannot receive as case`);
      return res.status(400).json({
        message: `${product.name} has no ${product.caseLabel || "case"} size set — receive it by each instead, or set a pack size on the product first`,
      });
    }

    const qty = Number(quantity);
    const cost = Number(costPerUnit);

    const newBatch = mode === "case"
      ? {
          quantity: qty * packSize,           // stored in eaches, like every other batch
          costPerUnit: cost / packSize,       // stored per-each, like every other batch
          receivedAsCases: qty,               // audit trail: what was actually typed in
          costPerCase: cost,
          expiryDate: expiryDate || null,
          receivedBy: req.user._id,
          supplierNote: supplierNote || "",
        }
      : {
          quantity: qty,
          costPerUnit: cost,
          expiryDate: expiryDate || null,
          receivedBy: req.user._id,
          supplierNote: supplierNote || "",
        };

    product.batches.push(newBatch);
    await product.save();

    logSuccess("product", "Stock received", {
      productId: product._id, mode, quantityInEaches: newBatch.quantity, newBatchCount: product.batches.length,
    });
    res.json(product);
  } catch (error) {
    next(error);
  }
};

// @desc    Sell/deduct stock FIFO — called internally by the checkout/payment flow
// @route   (not exposed directly — imported by orderController/paymentController)
export const sellProductStock = deductStockFIFO;

// @desc    Delete a product
// @route   DELETE /api/products/:id
// @access  Protected — branchManager, admin
export const deleteProduct = async (req, res, next) => {
  try {
    logStart("product", "Deleting product", { productId: req.params.id });

    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) {
      console.warn(`[product] ⚠️ Product not found: ${req.params.id}`);
      return res.status(404).json({ message: "Product not found" });
    }
    if (product.imagePublicId) {
      await cloudinary.uploader.destroy(product.imagePublicId).catch((err) => {
        console.warn(`[product] ⚠️ Failed to destroy Cloudinary asset ${product.imagePublicId}:`, err.message);
      });
    }

    logSuccess("product", "Product deleted", { productId: req.params.id, name: product.name });
    res.json({ message: "Product deleted" });
  } catch (error) {
    next(error);
  }
};
