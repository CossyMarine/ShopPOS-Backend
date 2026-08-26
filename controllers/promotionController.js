// controllers/promotionController.js
import Promotion from "../models/Promotion.js";
import AuditLog from "../models/AuditLog.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Create a promotion (percent/flat off, on a product list or a whole category)
// @route   POST /api/promotions
// @access  Protected — branchManager, admin
export const createPromotion = async (req, res, next) => {
  try {
    const { name, type, value, scope, products, category, branch, startDate, endDate, notes } = req.body;
    logStart("promotion", "Creating promotion", { name, type, scope });

    if (!["percent_off", "flat_off"].includes(type)) {
      return res.status(400).json({ message: "type must be percent_off or flat_off" });
    }
    if (type === "percent_off" && (value <= 0 || value > 100)) {
      return res.status(400).json({ message: "A percentage discount must be between 0 and 100" });
    }
    if (type === "flat_off" && value <= 0) {
      return res.status(400).json({ message: "A flat discount must be greater than 0" });
    }
    if (scope === "product" && (!Array.isArray(products) || products.length === 0)) {
      return res.status(400).json({ message: "Select at least one product for a product-scoped promotion" });
    }
    if (scope === "category" && !category) {
      return res.status(400).json({ message: "Select a category for a category-scoped promotion" });
    }
    if (new Date(endDate) <= new Date(startDate)) {
      return res.status(400).json({ message: "endDate must be after startDate" });
    }

    const promotion = await Promotion.create({
      name,
      type,
      value,
      scope,
      products: scope === "product" ? products : [],
      category: scope === "category" ? category : null,
      branch: branch || null,
      startDate,
      endDate,
      createdBy: req.user._id,
      notes: notes || "",
    });

    await AuditLog.create({
      entityType: "Promotion",
      entityId: promotion._id,
      action: "created",
      performedBy: req.user._id,
      branch: promotion.branch,
      details: { name, type, value, scope, startDate, endDate },
    });

    const io = req.app.get("io");
    if (promotion.branch) io.to(`branch:${promotion.branch}`).emit("promotion:created", promotion);
    else io.emit("promotion:created", promotion); // store-wide — every branch should hear about it

    logSuccess("promotion", "Promotion created", { promotionId: promotion._id });
    res.status(201).json(promotion);
  } catch (error) {
    next(error);
  }
};

// @desc    List promotions — defaults to everything; ?active=true filters to
//          currently live ones (on + inside date window) for a branch.
// @route   GET /api/promotions?branch=&active=true
// @access  Protected — storekeeper, branchManager, admin
export const getPromotions = async (req, res, next) => {
  try {
    const { branch, active } = req.query;
    const filter = {};
    if (branch) filter.$or = [{ branch: null }, { branch }];
    if (active === "true") {
      const now = new Date();
      filter.isActive = true;
      filter.startDate = { $lte: now };
      filter.endDate = { $gte: now };
    }

    const promotions = await Promotion.find(filter)
      .populate("products", "name")
      .populate("branch", "name")
      .populate("createdBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(promotions);
  } catch (error) {
    next(error);
  }
};

// @desc    Update a promotion (any field — dates, value, active toggle, scope)
// @route   PUT /api/promotions/:id
// @access  Protected — branchManager, admin
export const updatePromotion = async (req, res, next) => {
  try {
    const allowed = ["name", "type", "value", "scope", "products", "category", "branch", "startDate", "endDate", "isActive", "notes"];
    const updates = {};
    allowed.forEach((key) => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });

    logStart("promotion", "Updating promotion", { promotionId: req.params.id, fields: Object.keys(updates) });

    const existing = await Promotion.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: "Promotion not found" });

    if (updates.startDate && updates.endDate && new Date(updates.endDate) <= new Date(updates.startDate)) {
      return res.status(400).json({ message: "endDate must be after startDate" });
    }

    const before = existing.toObject();
    Object.assign(existing, updates);
    await existing.save();

    await AuditLog.create({
      entityType: "Promotion",
      entityId: existing._id,
      action: "updated",
      performedBy: req.user._id,
      branch: existing.branch,
      details: {
        name: existing.name,
        changedFields: Object.keys(updates),
        before: Object.fromEntries(Object.keys(updates).map((k) => [k, before[k]])),
        after: Object.fromEntries(Object.keys(updates).map((k) => [k, existing[k]])),
      },
    });

    const io = req.app.get("io");
    if (existing.branch) io.to(`branch:${existing.branch}`).emit("promotion:updated", existing);
    else io.emit("promotion:updated", existing);

    logSuccess("promotion", "Promotion updated", { promotionId: existing._id });
    res.json(existing);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a promotion outright (prefer isActive: false via updatePromotion
//          if you want it to stay in the audit trail — this fully removes it)
// @route   DELETE /api/promotions/:id
// @access  Protected — admin
export const deletePromotion = async (req, res, next) => {
  try {
    const promotion = await Promotion.findByIdAndDelete(req.params.id);
    if (!promotion) return res.status(404).json({ message: "Promotion not found" });

    await AuditLog.create({
      entityType: "Promotion",
      entityId: promotion._id,
      action: "deleted",
      performedBy: req.user._id,
      branch: promotion.branch,
      details: { name: promotion.name, type: promotion.type, value: promotion.value },
    });

    const io = req.app.get("io");
    if (promotion.branch) io.to(`branch:${promotion.branch}`).emit("promotion:deleted", { _id: promotion._id });
    else io.emit("promotion:deleted", { _id: promotion._id });

    logSuccess("promotion", "Promotion deleted", { promotionId: promotion._id });
    res.json({ message: "Promotion deleted" });
  } catch (error) {
    next(error);
  }
};
