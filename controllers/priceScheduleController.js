// controllers/priceScheduleController.js
import PriceSchedule from "../models/PriceSchedule.js";
import Product from "../models/Product.js";
import AuditLog from "../models/AuditLog.js";
import { applyDuePriceSchedules } from "../utils/applyScheduledPriceChanges.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Schedule a future price change on a product
// @route   POST /api/price-schedules
// @body    { product, field?: "sellingPrice"|"casePrice", newValue, effectiveAt }
// @access  Protected — branchManager, admin
export const createPriceSchedule = async (req, res, next) => {
  try {
    const { product: productId, field, newValue, effectiveAt } = req.body;
    logStart("priceSchedule", "Scheduling price change", { productId, field, newValue, effectiveAt });

    if (newValue === undefined || newValue < 0) {
      return res.status(400).json({ message: "newValue must be a non-negative number" });
    }
    if (!effectiveAt || new Date(effectiveAt) <= new Date()) {
      return res.status(400).json({ message: "effectiveAt must be in the future" });
    }

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    const useField = field === "casePrice" ? "casePrice" : "sellingPrice";
    if (useField === "casePrice" && (product.packSize || 1) === 1) {
      return res.status(400).json({ message: "This product has no case pricing to schedule" });
    }

    const schedule = await PriceSchedule.create({
      product: product._id,
      branch: product.branch,
      field: useField,
      valueAtScheduling: product[useField] ?? 0,
      newValue,
      effectiveAt,
      scheduledBy: req.user._id,
    });

    await AuditLog.create({
      entityType: "Product",
      entityId: product._id,
      action: "priceScheduled",
      performedBy: req.user._id,
      branch: product.branch,
      details: {
        productName: product.name,
        field: useField,
        currentValue: product[useField],
        newValue,
        effectiveAt,
        scheduleId: schedule._id,
      },
    });

    logSuccess("priceSchedule", "Price change scheduled", { scheduleId: schedule._id });
    res.status(201).json(schedule);
  } catch (error) {
    next(error);
  }
};

// @desc    List price schedules — defaults to pending ones for a branch.
//          Also runs a lazy catch-up of any overdue schedules first, so a
//          schedule that fell due while nobody was looking still applies.
// @route   GET /api/price-schedules?branch=&status=
// @access  Protected — storekeeper, branchManager, admin
export const getPriceSchedules = async (req, res, next) => {
  try {
    const io = req.app.get("io");
    await applyDuePriceSchedules(io);

    const { branch, status } = req.query;
    const filter = {};
    if (branch) filter.branch = branch;
    filter.status = status || "pending";

    const schedules = await PriceSchedule.find(filter)
      .populate("product", "name sellingPrice casePrice")
      .populate("scheduledBy", "fullName")
      .sort({ effectiveAt: 1 });

    res.json(schedules);
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel a pending price schedule before it applies
// @route   PATCH /api/price-schedules/:id/cancel
// @access  Protected — branchManager, admin
export const cancelPriceSchedule = async (req, res, next) => {
  try {
    const schedule = await PriceSchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ message: "Price schedule not found" });
    if (schedule.status !== "pending") {
      return res.status(400).json({ message: `Cannot cancel — already ${schedule.status}` });
    }

    schedule.status = "cancelled";
    schedule.cancelledBy = req.user._id;
    schedule.cancelledAt = new Date();
    await schedule.save();

    await AuditLog.create({
      entityType: "Product",
      entityId: schedule.product,
      action: "priceScheduleCancelled",
      performedBy: req.user._id,
      branch: schedule.branch,
      details: { field: schedule.field, newValue: schedule.newValue, effectiveAt: schedule.effectiveAt },
    });

    logSuccess("priceSchedule", "Price schedule cancelled", { scheduleId: schedule._id });
    res.json(schedule);
  } catch (error) {
    next(error);
  }
};
