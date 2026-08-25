// utils/promotionEngine.js
import Promotion from "../models/Promotion.js";

// Loads every promotion that COULD apply right now for a branch — active,
// inside its date window, and either store-wide (branch: null) or scoped to
// this exact branch. Callers then match individual products/categories
// against this list, so a checkout with many lines only hits the DB once.
export const loadLivePromotions = async (branchId, at = new Date()) => {
  return Promotion.find({
    isActive: true,
    startDate: { $lte: at },
    endDate: { $gte: at },
    $or: [{ branch: null }, { branch: branchId }],
  }).lean();
};

// Picks the single best promotion for one product out of an already-loaded
// list. "Best" = whichever produces the larger discount per unit — a
// product-scoped promo and a category-wide promo are never allowed to stack,
// since that's a fast way to accidentally sell something at a loss.
export const bestPromotionFor = (promotions, product) => {
  const candidates = promotions.filter((p) => {
    if (p.scope === "product") {
      return p.products?.some((id) => String(id) === String(product._id));
    }
    if (p.scope === "category") {
      return p.category && product.category && p.category.toLowerCase() === product.category.toLowerCase();
    }
    return false;
  });
  if (candidates.length === 0) return null;

  const discountPerUnit = (promo) =>
    promo.type === "percent_off"
      ? product.sellingPrice * (promo.value / 100)
      : Math.min(promo.value, product.sellingPrice); // never discount below zero

  return candidates.reduce((best, p) =>
    discountPerUnit(p) > discountPerUnit(best) ? p : best
  , candidates[0]);
};

// The actual per-line math, used identically by the live product catalog
// (for display) and by checkout (for the charge that's actually collected).
// Always clamps at 0 — a flat_off larger than the price never goes negative.
export const applyPromotionToLine = (promotions, product, quantity, unitPrice) => {
  const promo = bestPromotionFor(promotions, product);
  if (!promo) {
    return { unitPrice, lineTotal: unitPrice * quantity, promotionApplied: null, promotionName: null, discountAmount: 0 };
  }

  const discountPerUnit = promo.type === "percent_off"
    ? unitPrice * (promo.value / 100)
    : Math.min(promo.value, unitPrice);

  const discountedUnitPrice = Math.max(0, Number((unitPrice - discountPerUnit).toFixed(2)));
  const lineTotal = Number((discountedUnitPrice * quantity).toFixed(2));

  return {
    unitPrice: discountedUnitPrice,
    lineTotal,
    promotionApplied: promo._id,
    promotionName: promo.name,
    discountAmount: Number(((unitPrice - discountedUnitPrice) * quantity).toFixed(2)),
  };
};
