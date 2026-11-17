// controllers/productController.js
import Product from "../models/Product.js";
import "../models/Supplier.js"; // registers the Supplier model so populate("supplier") works
import { cloudinary } from "../Config/cloudinary.js";
import { deductStockFIFO } from "../utils/productStock.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";
import AuditLog from "../models/AuditLog.js";
import { applyDuePriceSchedules } from "../utils/applyScheduledPriceChanges.js";
import { loadLivePromotions, bestPromotionFor } from "../utils/promotionEngine.js";
import { badRequest } from "../utils/AppError.js";

// ---------------------------------------------------------------------------
// Pack helpers
// ---------------------------------------------------------------------------

// Validates and cleans the packs[] array sent by the frontend.
const preparePacks = (raw) => {
  const seen = new Set();
  return (raw || []).map((r) => {
    const name = String(r.name || "").trim();
    const qty = Number(r.qty);
    if (!name) throw badRequest("Every pack needs a name");
    if (!Number.isInteger(qty) || qty < 2) throw badRequest(`${name} must contain a whole number above 1`);
    if (seen.has(name.toLowerCase())) throw badRequest(`Pack name "${name}" is used twice`);
    seen.add(name.toLowerCase());
    const pack = {
      name,
      qty,
      barcode: String(r.barcode || "").trim() || null,
      price: Number(r.price) > 0 ? Number(r.price) : null,
    };
    if (r._id) pack._id = r._id; // keep ids of existing packs stable
    return pack;
  });
};

// The largest pack drives the old single-pack fields, so the cashier,
// stock transfers and pricing code (which still read packSize / caseLabel /
// caseBarcode / casePrice) keep working untouched.
const legacyFrom = (packs) => {
  const big = [...packs].sort((a, b) => b.qty - a.qty)[0];
  return big
    ? { packSize: big.qty, caseLabel: big.name, caseBarcode: big.barcode || null, casePrice: big.price }
    : { packSize: 1, caseLabel: "Carton", caseBarcode: null, casePrice: null };
};

// A barcode may belong to only one product per branch — each barcode, the
// case barcode, and every pack barcode are all checked.
const checkCodes = async (branch, selfId, barcode, packs) => {
  const codes = [barcode, ...packs.map((p) => p.barcode)].filter(Boolean);
  if (new Set(codes).size !== codes.length) throw badRequest("Two barcodes on this product are the same");
  if (!codes.length) return;
  const q = {
    branch,
    $or: [{ barcode: { $in: codes } }, { caseBarcode: { $in: codes } }, { "packs.barcode": { $in: codes } }],
  };
  if (selfId) q._id = { $ne: selfId };
  const clash = await Product.findOne(q).select("name");
  if (clash) throw badRequest(`A barcode on this product already belongs to "${clash.name}"`);
};

// One-time lazy conversion: old single-pack products (packSize > 1) get a
// matching entry in packs[]. After the first run the query finds nothing.
const migrateLegacyPacks = async (branch) => {
  const q = { packSize: { $gt: 1 }, $or: [{ packs: { $exists: false } }, { packs: { $size: 0 } }] };
  if (branch) q.branch = branch;
  const old = await Product.find(q).select("packSize caseLabel caseBarcode casePrice").lean();
  for (const p of old) {
    await Product.updateOne(
      { _id: p._id },
      { $set: { packs: [{ name: p.caseLabel || "Carton", qty: p.packSize, barcode: p.caseBarcode || null, price: p.casePrice ?? null }] } }
    );
  }
};

// @desc    Get products for a branch (falls back to name if no image — handled in frontend)
// @route   GET /api/products?branch=<id>&status=active|archived|all
// @access  Public (customer catalog) / Protected (staff, auto-scoped via sameBranch)
export const getProducts = async (req, res, next) => {
  try {
    logStart("product", "Loading products", { branch: req.query.branch || "all" });

    // Lazy catch-up: applies any price schedule whose effective time has
    // already passed, in case the cron missed it (server asleep, etc). This
    // is the main "load the catalog" entrypoint every screen hits, so it's
    // the most reliable place to guarantee schedules are never stale for long.
    const io = req.app.get("io");
    await applyDuePriceSchedules(io);

    // Cashiers and the public catalog only ever see active products.
    // Stock staff can also ask for archived products or everything.
    const isCashierReq = req.user?.role === "cashier";
    const status = !req.user || isCashierReq ? "active" : (req.query.status || "active");
    const filter =
      status === "archived" ? { isActive: false } :
      status === "all" ? {} :
      { isActive: true };
    if (req.query.branch) filter.branch = req.query.branch;

    if (req.user && !isCashierReq) await migrateLegacyPacks(req.query.branch);

    const products = await Product.find(filter)
      .populate("unit", "name abbreviation")
      .populate("supplier", "name")
      .sort({ category: 1, name: 1 });

    const livePromotions = req.query.branch ? await loadLivePromotions(req.query.branch) : [];

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

      // A live preview of what checkout would actually charge — same math
      // that runs server-side in createOrder, so the cart never surprises
      // anyone with a different number at payment time.
      const promo = bestPromotionFor(livePromotions, p);
      if (promo) {
        const discountPerUnit = promo.type === "percent_off"
          ? p.sellingPrice * (promo.value / 100)
          : Math.min(promo.value, p.sellingPrice);
        obj.activePromotion = {
          _id: promo._id,
          name: promo.name,
          type: promo.type,
          value: promo.value,
          effectivePrice: Number(Math.max(0, p.sellingPrice - discountPerUnit).toFixed(2)),
        };
      } else {
        obj.activePromotion = null;
      }
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
//          packs: [{ name, qty, barcode?, price? }] — any number of pack sizes
//          opening: { quantity (in base units), costPerUnit (per base unit), expiryDate? }
//                   optional stock already on the shelf
// @route   POST /api/products
// @access  Protected — storekeeper, branchManager, admin
export const createProduct = async (req, res, next) => {
  try {
    const {
      name, barcode, category, unit, sellingPrice, reorderLevel, packs, sku, description,
      maxLevel, reorderQty, perishable, allowDecimals, supplier,
      imageUrl, imagePublicId, branch, vatClass, opening,
    } = req.body;

    logStart("product", "Creating product", { name, branch, sellingPrice });

    if (!name || !unit || !sellingPrice || !branch) {
      console.warn("[product] ⚠️ Missing required field(s) on create");
      return res.status(400).json({ message: "Name, unit, sellingPrice and branch are required" });
    }
    if (Number(maxLevel) > 0 && Number(maxLevel) <= Number(reorderLevel || 0)) {
      return res.status(400).json({ message: "Max level must be higher than the reorder level" });
    }

    const cleanPacks = preparePacks(packs);
    await checkCodes(branch, null, barcode || null, cleanPacks);

    const product = new Product({
      name, barcode: barcode || undefined, category: category || "General",
      unit, sellingPrice, reorderLevel: reorderLevel || 0,
      packs: cleanPacks, ...legacyFrom(cleanPacks),
      sku: sku || "", description: description || "",
      maxLevel: Number(maxLevel) || 0, reorderQty: Number(reorderQty) || 0,
      perishable: !!perishable,
      allowDecimals: typeof allowDecimals === "boolean" ? allowDecimals : null,
      supplier: supplier || null,
      imageUrl: imageUrl || null, imagePublicId: imagePublicId || null,
      vatClass: vatClass || "standard",
      branch, batches: [],
    });

    // Optional opening stock — already converted to base units by the frontend
    if (opening && Number(opening.quantity) > 0) {
      if (!(Number(opening.costPerUnit) > 0)) {
        return res.status(400).json({ message: "Enter the buying cost for the opening stock" });
      }
      product.batches.push({
        quantity: Number(opening.quantity),
        costPerUnit: Number(opening.costPerUnit),
        expiryDate: opening.expiryDate || null,
        receivedBy: req.user._id,
        supplierNote: "Opening stock",
      });
    }

    await product.save();

    logSuccess("product", "Product created", { productId: product._id, name });
    res.status(201).json(product);
  } catch (error) {
    next(error);
  }
};

// @desc    Update product details (name, price, category, barcode, image, packs, stock rules, archive)
// @route   PUT /api/products/:id
// @access  Protected — storekeeper, branchManager, admin
export const updateProduct = async (req, res, next) => {
  try {
    const allowed = [
      "name", "barcode", "category", "unit", "sellingPrice", "reorderLevel",
      "imageUrl", "imagePublicId", "isActive", "vatClass",
      "sku", "description", "maxLevel", "reorderQty", "perishable", "allowDecimals", "supplier",
    ];
    const updates = {};
    allowed.forEach((key) => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });

    logStart("product", "Updating product", { productId: req.params.id, fields: Object.keys(updates) });

    const existing = await Product.findById(req.params.id);
    if (!existing) {
      console.warn(`[product] ⚠️ Product not found: ${req.params.id}`);
      return res.status(404).json({ message: "Product not found" });
    }

    if (updates.supplier === "") updates.supplier = null;

    if (updates.maxLevel !== undefined && Number(updates.maxLevel) > 0) {
      const rl = updates.reorderLevel !== undefined ? Number(updates.reorderLevel) : existing.reorderLevel;
      if (Number(updates.maxLevel) <= rl) {
        return res.status(400).json({ message: "Max level must be higher than the reorder level" });
      }
    }

    // Packs: validate, check barcodes, and keep the old single-pack fields in
    // sync with the largest pack so cashier / transfers keep working.
    if (req.body.packs !== undefined) {
      const cleanPacks = preparePacks(req.body.packs);
      await checkCodes(
        existing.branch,
        existing._id,
        updates.barcode !== undefined ? updates.barcode : existing.barcode,
        cleanPacks
      );
      updates.packs = cleanPacks;
      Object.assign(updates, legacyFrom(cleanPacks));
    }

    if (updates.imagePublicId !== undefined && existing.imagePublicId && existing.imagePublicId !== updates.imagePublicId) {
      console.log(`[product] → Replacing image — destroying old Cloudinary asset ${existing.imagePublicId}`);
      await cloudinary.uploader.destroy(existing.imagePublicId).catch((err) => {
        console.warn(`[product] ⚠️ Failed to destroy old Cloudinary asset ${existing.imagePublicId}:`, err.message);
      });
    }

    const product = await Product.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });

    // Price changes go on the audit trail too — a direct edit here is just
    // as much a pricing decision as a scheduled one, and "who changed what
    // and when" shouldn't have a blind spot for the immediate-effect path.
    if (updates.sellingPrice !== undefined && updates.sellingPrice !== existing.sellingPrice) {
      await AuditLog.create({
        entityType: "Product",
        entityId: product._id,
        action: "priceChanged",
        performedBy: req.user._id,
        branch: product.branch,
        details: { productName: product.name, field: "sellingPrice", previousValue: existing.sellingPrice, newValue: updates.sellingPrice },
      });
    }
    if (updates.casePrice !== undefined && updates.casePrice !== existing.casePrice) {
      await AuditLog.create({
        entityType: "Product",
        entityId: product._id,
        action: "priceChanged",
        performedBy: req.user._id,
        branch: product.branch,
        details: { productName: product.name, field: "casePrice", previousValue: existing.casePrice, newValue: updates.casePrice },
      });
    }

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
//          NOTE: the new Receive Stock screen uses POST /api/goods-receipts
//          instead (multi-product, mixed units, invoice, discounts). This
//          older single-product endpoint is kept for backwards compatibility.
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
