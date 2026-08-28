// controllers/stockAdjustmentController.js
import StockAdjustment from "../models/StockAdjustment.js";
import AuditLog from "../models/AuditLog.js";
import Product from "../models/Product.js";
import { deductStockFIFO } from "../utils/productStock.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

const PHOTO_REQUIRED_REASONS = ["damaged", "stolen"];

// @desc    Request a stock adjustment (loss/write-off) — does NOT touch
//          stock yet. Cashier/storekeeper file the report; a manager has
//          to approve it before any quantity actually changes.
// @route   POST /api/stock-adjustments
// @body    { productId, quantity, reason, note?, photoUrl?, photoPublicId? }
// @access  Protected — cashier, storekeeper, branchManager, admin
export const createStockAdjustment = async (req, res, next) => {
  try {
    const { productId, quantity, reason, note, photoUrl, photoPublicId } = req.body;
    logStart("stockAdjustment", "Requesting adjustment", { productId, quantity, reason, by: req.user._id });

    if (!productId || !quantity || Number(quantity) <= 0 || !reason) {
      return res.status(400).json({ message: "productId, a positive quantity, and reason are required" });
    }

    if (PHOTO_REQUIRED_REASONS.includes(reason) && !photoUrl) {
      return res.status(400).json({ message: `Photo evidence is required when reason is "${reason}"` });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    if (String(product.branch) !== String(req.user.branch) && !req.user.isAdmin) {
      return res.status(403).json({ message: "You can only adjust stock for your own branch" });
    }

    const currentStock = (product.batches || []).reduce((sum, b) => sum + b.quantity, 0);
    if (Number(quantity) > currentStock) {
      return res.status(400).json({
        message: `Cannot report a loss of ${quantity} — only ${currentStock} currently in stock`,
      });
    }

    const adjustment = await StockAdjustment.create({
      product: productId,
      branch: product.branch,
      quantity: Number(quantity),
      reason,
      note: note || "",
      photoUrl: photoUrl || null,
      photoPublicId: photoPublicId || null,
      requestedBy: req.user._id,
    });

    await AuditLog.create({
      entityType: "StockAdjustment",
      entityId: adjustment._id,
      action: "created",
      performedBy: req.user._id,
      branch: product.branch,
      details: {
        productName: product.name,
        quantity: adjustment.quantity,
        reason,
        note: note || "",
        hadPhoto: !!photoUrl,
      },
    });

    const io = req.app.get("io");
    io.to(`branch:${product.branch}`).emit("stockAdjustment:created", adjustment);

    logSuccess("stockAdjustment", "Adjustment requested", { adjustmentId: adjustment._id });
    res.status(201).json({ message: "Adjustment submitted for approval", adjustment });
  } catch (error) {
    next(error);
  }
};

// @desc    List pending adjustments (omit ?branch= as Super Admin to see all)
// @route   GET /api/stock-adjustments?branch=&status=
// @access  Protected — branchManager, admin
export const getStockAdjustments = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.branch) filter.branch = req.query.branch;
    filter.status = req.query.status || "pending";

    const adjustments = await StockAdjustment.find(filter)
      .populate("product", "name category unit")
      .populate("requestedBy", "fullName role")
      .populate("reviewedBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(adjustments);
  } catch (error) {
    next(error);
  }
};

// @desc    Approve — this is the ONLY place stock actually decreases.
//          Deducts FIFO (oldest batch first) so costImpact reflects the
//          real weighted cost of what was lost, not a guess.
// @route   PATCH /api/stock-adjustments/:id/approve
// @access  Protected — branchManager, admin
export const approveStockAdjustment = async (req, res, next) => {
  try {
    const adjustment = await StockAdjustment.findById(req.params.id);
    if (!adjustment) return res.status(404).json({ message: "Adjustment not found" });
    if (adjustment.status !== "pending") {
      return res.status(400).json({ message: `Already ${adjustment.status}` });
    }

    const product = await Product.findById(adjustment.product);
    if (!product) return res.status(404).json({ message: "Product no longer exists" });

    const currentStock = (product.batches || []).reduce((sum, b) => sum + b.quantity, 0);
    if (adjustment.quantity > currentStock) {
      return res.status(400).json({
        message: `Stock has changed since this was requested — only ${currentStock} available now`,
      });
    }

    const { totalCost } = await deductStockFIFO(product, adjustment.quantity);

    adjustment.status = "approved";
    adjustment.reviewedBy = req.user._id;
    adjustment.reviewedAt = new Date();
    adjustment.costImpact = Number(totalCost.toFixed(2));
    await adjustment.save();

    await AuditLog.create({
      entityType: "StockAdjustment",
      entityId: adjustment._id,
      action: "approved",
      performedBy: req.user._id,
      branch: adjustment.branch,
      details: {
        productName: product.name,
        quantity: adjustment.quantity,
        reason: adjustment.reason,
        costImpact: adjustment.costImpact,
        requestedBy: adjustment.requestedBy,
      },
    });

    const io = req.app.get("io");
    io.to(`branch:${adjustment.branch}`).emit("stockAdjustment:approved", adjustment);
    io.to(`branch:${adjustment.branch}`).emit("product:updated", product);

    res.json({ message: "Adjustment approved, stock updated", adjustment, product });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject — stock is untouched, but the request stays on record
// @route   PATCH /api/stock-adjustments/:id/reject
// @body    { rejectionNote? }
// @access  Protected — branchManager, admin
export const rejectStockAdjustment = async (req, res, next) => {
  try {
    const adjustment = await StockAdjustment.findById(req.params.id);
    if (!adjustment) return res.status(404).json({ message: "Adjustment not found" });
    if (adjustment.status !== "pending") {
      return res.status(400).json({ message: `Already ${adjustment.status}` });
    }

    adjustment.status = "rejected";
    adjustment.reviewedBy = req.user._id;
    adjustment.reviewedAt = new Date();
    adjustment.rejectionNote = req.body.rejectionNote || "";
    await adjustment.save();

    await AuditLog.create({
      entityType: "StockAdjustment",
      entityId: adjustment._id,
      action: "rejected",
      performedBy: req.user._id,
      branch: adjustment.branch,
      details: { rejectionNote: adjustment.rejectionNote, requestedBy: adjustment.requestedBy },
    });

    const io = req.app.get("io");
    io.to(`branch:${adjustment.branch}`).emit("stockAdjustment:rejected", adjustment);

    res.json({ message: "Adjustment rejected", adjustment });
  } catch (error) {
    next(error);
  }
};

// @desc    Full audit history for a branch — every create/approve/reject,
//          forever. This is what catches patterns (same storekeeper,
//          same product, repeated "shrinkage" claims).
// @route   GET /api/stock-adjustments/audit-log?branch=&entityType=&performedBy=
// @access  Protected — admin (branchManager can see their own branch only)
export const getAuditLog = async (req, res, next) => {
  try {
    const filter = {};
    if (req.user.isAdmin) {
      if (req.query.branch) filter.branch = req.query.branch;
    } else {
      filter.branch = req.user.branch; // branchManager locked to own branch
    }
    if (req.query.entityType) filter.entityType = req.query.entityType;
    if (req.query.performedBy) filter.performedBy = req.query.performedBy;

    const logs = await AuditLog.find(filter)
      .populate("performedBy", "fullName role")
      .sort({ createdAt: -1 })
      .limit(500);

    res.json(logs);
  } catch (error) {
    next(error);
  }
};
// @desc    Groups approved shrinkage (damaged/expired/stolen/spillage/etc.)
//          by the shift it happened under — not just by who filed it, since
//          the person filing an adjustment and the person whose till was
//          actually open when the loss occurred aren't always the same.
//          Only APPROVED adjustments count here: pending ones haven't been
//          confirmed as real loss yet, and rejected ones were determined
//          not to be loss at all — including either would overstate shrinkage.
// @route   GET /api/stock-adjustments/shrinkage-by-shift?branch=&from=&to=
// @access  Protected — branchManager, admin
export const getShrinkageByShift = async (req, res, next) => {
  try {
    const filter = { status: "approved" };
    if (req.user.isAdmin) {
      if (req.query.branch) filter.branch = req.query.branch;
    } else {
      filter.branch = req.user.branch; // branchManager locked to own branch
    }
    if (req.query.from || req.query.to) {
      filter.reviewedAt = {};
      if (req.query.from) filter.reviewedAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.reviewedAt.$lte = new Date(req.query.to);
    }

    const rows = await StockAdjustment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$shift", // null groups together every adjustment with no shift attached
          adjustmentCount: { $sum: 1 },
          totalQuantity: { $sum: "$quantity" },
          totalCostImpact: { $sum: { $ifNull: ["$costImpact", 0] } },
          reasons: { $push: "$reason" },
        },
      },
      { $sort: { totalCostImpact: -1 } },
    ]);

    const shiftIds = rows.map((r) => r._id).filter(Boolean);
    const shifts = await Shift.find({ _id: { $in: shiftIds } })
      .populate("openedBy", "fullName")
      .populate("closedBy", "fullName")
      .populate("branch", "name")
      .lean();
    const shiftMap = new Map(shifts.map((s) => [String(s._id), s]));

    // Tally up how many times each reason (damaged/expired/stolen/...)
    // occurred within a group, instead of leaving the raw array for the
    // frontend to count itself.
    const summarize = (reasons) =>
      reasons.reduce((acc, r) => ({ ...acc, [r]: (acc[r] || 0) + 1 }), {});

    const results = rows.map((r) => {
      const shift = r._id ? shiftMap.get(String(r._id)) : null;
      return {
        shiftId: r._id,
        shift: shift
          ? {
              openedBy: shift.openedBy?.fullName || null,
              closedBy: shift.closedBy?.fullName || null,
              branchName: shift.branch?.name || null,
              openedAt: shift.createdAt,
              closedAt: shift.closedAt,
              status: shift.status,
            }
          : null, // no shift was open when this was filed
        adjustmentCount: r.adjustmentCount,
        totalQuantity: r.totalQuantity,
        totalCostImpact: Math.round(r.totalCostImpact),
        reasonBreakdown: summarize(r.reasons),
      };
    });

    res.json(results);
  } catch (error) {
    next(error);
  }
};
