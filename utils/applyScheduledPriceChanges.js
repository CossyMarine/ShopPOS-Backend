// utils/applyScheduledPriceChanges.js
import PriceSchedule from "../models/PriceSchedule.js";
import Product from "../models/Product.js";
import AuditLog from "../models/AuditLog.js";

// Applies every price schedule whose effectiveAt has arrived. Called on a
// 1-minute cron (see server.js) AND lazily from getProducts, so a schedule
// still lands on time even if the server was asleep (Render free tier) right
// through its effective moment — the next product fetch catches it up.
export const applyDuePriceSchedules = async (io = null) => {
  const due = await PriceSchedule.find({ status: "pending", effectiveAt: { $lte: new Date() } });
  if (due.length === 0) return [];

  const applied = [];

  for (const schedule of due) {
    const product = await Product.findById(schedule.product);
    if (!product) {
      // Product was deleted after scheduling — close the schedule out so it
      // doesn't sit in "pending" forever with nothing left to apply to.
      schedule.status = "cancelled";
      schedule.cancelledAt = new Date();
      await schedule.save();
      continue;
    }

    const previousValue = product[schedule.field];
    product[schedule.field] = schedule.newValue;
    await product.save();

    schedule.status = "applied";
    schedule.appliedAt = new Date();
    schedule.previousValueAtApply = previousValue;
    await schedule.save();

    await AuditLog.create({
      entityType: "Product",
      entityId: product._id,
      action: "scheduledPriceApplied",
      performedBy: schedule.scheduledBy, // the change is attributed to whoever scheduled it, not "the system"
      branch: schedule.branch,
      details: {
        productName: product.name,
        field: schedule.field,
        previousValue,
        newValue: schedule.newValue,
        scheduleId: schedule._id,
      },
    });

    applied.push({ product, schedule });

    if (io) {
      io.to(`branch:${schedule.branch}`).emit("product:updated", product);
      io.to(`branch:${schedule.branch}`).emit("priceSchedule:applied", schedule);
    }
  }

  return applied;
};
