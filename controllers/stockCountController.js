// controllers/stockCountController.js
import StockCount from "../models/StockCount.js";
import Product from "../models/Product.js";
import AuditLog from "../models/AuditLog.js";
import { deductStockFIFO } from "../utils/productStock.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// Weighted-average cost per "each" unit across a product's remaining batches —
// used to price count variances. Mirrors the frontend's avgCostPerEach.
const avgCostPerEach = (product) => {
  const batches = product.batches || [];
  const totalQty = batches.reduce((s, b) => s + b.quantity, 0);
  if (!totalQty) return 0;
  const totalCost = batches.reduce((s, b) => s + b.quantity * b.costPerUnit, 0);
  return totalCost / totalQty;
};

// @desc    Start a new stock-take session — snapshots current system
//          quantities for every active product in the branch (optionally
//          scoped to one category) so staff can count against a frozen list.
// @route   POST /api/stock-counts
// @body    { branch, category? , note? }
// @access  Protected — storekeeper, branchManager, admin
export const startStockCount = async (req, res, next) => {
  try {
    const { branch, category, note } = req.body;
    logStart("stockCount", "Starting stock count", { branch, category, by: req.user._id });

    if (!branch) return res.status(400).json({ message: "branch is required" });

    // Only one open (draft/submitted) count per branch+category at a time —
    // otherwise two overlapping counts would double-count the same variance.
    const existing = await StockCount.findOne({
      branch,
      category: category || null,
      status: { $in: ["draft", "submitted"] },
    });
    if (existing) {
      return res.status(400).json({
        message: "A stock count is already in progress for this branch/category",
        stockCountId: existing._id,
      });
    }

    const filter = { branch, isActive: true };
    if (category) filter.category = category;
    const products = await Product.find(filter).select("name batches");

    if (products.length === 0) {
      return res.status(400).json({ message: "No active products found to count" });
    }

    const lines = products.map((p) => ({
      product: p._id,
      productName: p.name,
      systemQty: (p.batches || []).reduce((sum, b) => sum + b.quantity, 0),
    }));

    const stockCount = await StockCount.create({
      branch,
      category: category || null,
      lines,
      startedBy: req.user._id,
      note: note || "",
    });

    logSuccess("stockCount", "Stock count started", { stockCountId: stockCount._id, productCount: lines.length });
    res.status(201).json(stockCount);
  } catch (error) {
    next(error);
  }
};

// @desc    List stock counts (defaults to draft/submitted only)
// @route   GET /api/stock-counts?branch=&status=
// @access  Protected — storekeeper, branchManager, admin
export const getStockCounts = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.branch) filter.branch = req.query.branch;
    if (req.query.status) {
      filter.status = req.query.status;
    } else {
      filter.status = { $in: ["draft", "submitted"] };
    }

    const counts = await StockCount.find(filter)
      .populate("startedBy", "fullName")
      .populate("submittedBy", "fullName")
      .populate("reconciledBy", "fullName")
      .select("-lines") // list view doesn't need every line — fetch by id for that
      .sort({ createdAt: -1 });

    res.json(counts);
  } catch (error) {
    next(error);
  }
};

// @desc    Get one stock count with full line detail
// @route   GET /api/stock-counts/:id
// @access  Protected — storekeeper, branchManager, admin
export const getStockCountById = async (req, res, next) => {
  try {
    const stockCount = await StockCount.findById(req.params.id)
      .populate("startedBy", "fullName")
      .populate("submittedBy", "fullName")
      .populate("reconciledBy", "fullName");
    if (!stockCount) return res.status(404).json({ message: "Stock count not found" });
    res.json(stockCount);
  } catch (error) {
    next(error);
  }
};

// @desc    Save counted quantities as staff walk the floor — can be called
//          repeatedly while status is "draft" (autosave-friendly), only
//          touches the lines included in the request body.
// @route   PATCH /api/stock-counts/:id/lines
// @body    { lines: [{ product, countedQty }] }
// @access  Protected — storekeeper, branchManager, admin
export const updateStockCountLines = async (req, res, next) => {
  try {
    const { lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines must be a non-empty array" });
    }

    const stockCount = await StockCount.findById(req.params.id);
    if (!stockCount) return res.status(404).json({ message: "Stock count not found" });
    if (stockCount.status !== "draft") {
      return res.status(400).json({ message: `Cannot edit counts — this count is already ${stockCount.status}` });
    }

    const updates = new Map(lines.map((l) => [String(l.product), Number(l.countedQty)]));
    stockCount.lines.forEach((line) => {
      if (updates.has(String(line.product))) {
        const counted = updates.get(String(line.product));
        line.countedQty = isNaN(counted) ? null : counted;
      }
    });

    await stockCount.save();
    res.json(stockCount);
  } catch (error) {
    next(error);
  }
};

// @desc    Lock the count for review — computes variance per line (does NOT
//          touch product stock yet; that only happens on reconcile).
// @route   PATCH /api/stock-counts/:id/submit
// @access  Protected — storekeeper, branchManager, admin
export const submitStockCount = async (req, res, next) => {
  try {
    const stockCount = await StockCount.findById(req.params.id);
    if (!stockCount) return res.status(404).json({ message: "Stock count not found" });
    if (stockCount.status !== "draft") {
      return res.status(400).json({ message: `Already ${stockCount.status}` });
    }

    const uncounted = stockCount.lines.filter((l) => l.countedQty === null);
    if (uncounted.length > 0) {
      return res.status(400).json({
        message: `${uncounted.length} product(s) still need a counted quantity`,
        uncountedProducts: uncounted.map((l) => l.productName),
      });
    }

    stockCount.lines.forEach((line) => {
      line.varianceQty = Number((line.countedQty - line.systemQty).toFixed(3));
    });

    stockCount.status = "submitted";
    stockCount.submittedBy = req.user._id;
    stockCount.submittedAt = new Date();
    await stockCount.save();

    const io = req.app.get("io");
    io.to(`branch:${stockCount.branch}`).emit("stockCount:submitted", stockCount);

    res.json(stockCount);
  } catch (error) {
    next(error);
  }
};

// @desc    Manager approves — this is the ONLY place stock actually changes.
//          For each line with a nonzero variance: a shortage (negative)
//          deducts FIFO like any other loss; a surplus (positive) adds a new
//          batch at the product's current weighted-average cost. Every line
//          gets its own AuditLog entry so this is fully traceable per product.
// @route   PATCH /api/stock-counts/:id/reconcile
// @access  Protected — branchManager, admin
export const reconcileStockCount = async (req, res, next) => {
  try {
    const stockCount = await StockCount.findById(req.params.id);
    if (!stockCount) return res.status(404).json({ message: "Stock count not found" });
    if (stockCount.status !== "submitted") {
      return res.status(400).json({ message: `Cannot reconcile — status is ${stockCount.status}, not submitted` });
    }

    let totalVarianceQty = 0;
    let totalCostImpact = 0;
    const io = req.app.get("io");

    for (const line of stockCount.lines) {
      if (!line.varianceQty) continue; // exact match — nothing to do

      const product = await Product.findById(line.product);
      if (!product) continue; // product deleted since the count started — skip, note stays in the line

      const unitCost = avgCostPerEach(product);
      line.unitCostAtReconcile = Number(unitCost.toFixed(2));

      if (line.varianceQty < 0) {
        // Shortage — fewer on the shelf than the system thinks. Deduct FIFO,
        // capped at what's actually there in case stock moved since submit.
        const shortfall = Math.min(Math.abs(line.varianceQty), product.currentStock ?? 0);
        if (shortfall > 0) {
          const { totalCost } = await deductStockFIFO(product, shortfall);
          line.costImpact = Number((-totalCost).toFixed(2));
        } else {
          line.costImpact = 0;
        }
      } else {
        // Surplus — more on the shelf than expected. Add a "found stock"
        // batch at current average cost so the value isn't invented from nothing.
        product.batches.push({
          quantity: line.varianceQty,
          costPerUnit: unitCost,
          receivedBy: req.user._id,
          supplierNote: `Stock count surplus — count #${stockCount._id}`,
        });
        await product.save();
        line.costImpact = Number((line.varianceQty * unitCost).toFixed(2));
      }

      totalVarianceQty += line.varianceQty;
      totalCostImpact += line.costImpact;

      await AuditLog.create({
        entityType: "StockCount",
        entityId: stockCount._id,
        action: "line_reconciled",
        performedBy: req.user._id,
        branch: stockCount.branch,
        details: {
          productId: product._id,
          productName: line.productName,
          systemQty: line.systemQty,
          countedQty: line.countedQty,
          varianceQty: line.varianceQty,
          costImpact: line.costImpact,
        },
      });

      io.to(`branch:${stockCount.branch}`).emit("product:updated", product);
    }

    stockCount.status = "reconciled";
    stockCount.reconciledBy = req.user._id;
    stockCount.reconciledAt = new Date();
    stockCount.totalVarianceQty = Number(totalVarianceQty.toFixed(3));
    stockCount.totalCostImpact = Number(totalCostImpact.toFixed(2));
    await stockCount.save();

    io.to(`branch:${stockCount.branch}`).emit("stockCount:reconciled", stockCount);

    logSuccess("stockCount", "Stock count reconciled", {
      stockCountId: stockCount._id, totalVarianceQty, totalCostImpact,
    });
    res.json(stockCount);
  } catch (error) {
    next(error);
  }
};

// @desc    Abandon a count before it's reconciled — no stock is touched
//          since a draft/submitted count never modifies product batches.
// @route   PATCH /api/stock-counts/:id/cancel
// @access  Protected — branchManager, admin
export const cancelStockCount = async (req, res, next) => {
  try {
    const stockCount = await StockCount.findById(req.params.id);
    if (!stockCount) return res.status(404).json({ message: "Stock count not found" });
    if (!["draft", "submitted"].includes(stockCount.status)) {
      return res.status(400).json({ message: `Cannot cancel — already ${stockCount.status}` });
    }

    stockCount.status = "cancelled";
    await stockCount.save();

    res.json({ message: "Stock count cancelled", stockCount });
  } catch (error) {
    next(error);
  }
};
