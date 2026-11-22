// controllers/productInsightsController.js
import mongoose from "mongoose";
import Product from "../models/Product.js";
import GoodsReceipt from "../models/GoodsReceipt.js";
import Receipt from "../models/Receipt.js";
import { notFound, forbidden } from "../utils/AppError.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

// @route GET /api/products/:id/insights
// @access storekeeper, branchManager, admin
export const getProductInsights = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw notFound("Product");

    const product = await Product.findById(id)
      .populate("unit", "name abbreviation")
      .populate("supplier", "name")
      .populate("batches.receivedBy", "fullName");
    if (!product) throw notFound("Product");
    if (!req.user.isAdmin && String(product.branch) !== String(req.user.branch)) {
      throw forbidden("You can only view your own branch");
    }

    const pid = product._id;
    const batches = product.batches || [];
    const remainingStock = batches.reduce((s, b) => s + b.quantity, 0);
    const avgCost = remainingStock > 0
      ? batches.reduce((s, b) => s + b.quantity * b.costPerUnit, 0) / remainingStock
      : (batches.at(-1)?.costPerUnit || 0);

    // Deliveries: sold-out batches are deleted from product.batches,
    // so GoodsReceipt lines are the permanent history.
    const grns = await GoodsReceipt.find({ branch: product.branch, "lines.product": pid })
      .sort({ deliveryDate: -1, createdAt: -1 })
      .limit(60)
      .populate("receivedBy", "fullName");

    const deliveries = grns.map((g) => {
      const line = g.lines.find((l) => String(l.product) === String(pid));
      const mine = batches.filter((b) => String(b.receipt) === String(g._id));
      return {
        id: String(g._id),
        kind: "delivery",
        grn: g.no,
        receivedAt: g.deliveryDate || g.createdAt,
        invoice: g.invoice || "",
        supplierName: g.supplierName || "",
        receivedBy: g.receivedBy?.fullName || g.receivedByName || "",
        boughtText: line.boughtText || "",
        batchNo: line.batchNo || "",
        quantity: line.addedBase,
        remaining: mine.reduce((s, b) => s + b.quantity, 0),
        costPerUnit: line.effCost,
        expiryDate: line.expiryDate || null,
      };
    });

    // Batches not created by a goods receipt (opening stock, corrections, restocks)
    const knownReceipts = new Set(grns.map((g) => String(g._id)));
    const others = batches
      .filter((b) => !b.receipt || !knownReceipts.has(String(b.receipt)))
      .map((b) => ({
        id: String(b._id),
        kind: "other",
        grn: "",
        receivedAt: b.receivedAt,
        invoice: "",
        supplierName: "",
        note: b.supplierNote || "",
        receivedBy: b.receivedBy?.fullName || "",
        boughtText: (b.boughtAs || []).map((x) => `${x.qty} ${x.name}`).join(" + "),
        batchNo: b.batchNo || "",
        quantity: b.quantity,
        remaining: b.quantity,
        costPerUnit: b.costPerUnit,
        expiryDate: b.expiryDate || null,
      }));

    const allDeliveries = [...deliveries, ...others]
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    // Sales, last 30 days
    const since = new Date(Date.now() - 30 * 864e5);
    const bills = await Receipt.aggregate([
      { $match: { branch: product.branch, status: { $in: ["paid", "partial"] }, createdAt: { $gte: since }, "items.productId": pid } },
      { $project: {
          billId: 1, cashierName: 1, createdAt: 1, paidAt: 1, vatEnabled: 1, vatRate: 1, priceMode: 1,
          items: { $filter: { input: "$items", as: "i", cond: { $eq: ["$$i.productId", pid] } } },
      } },
      { $sort: { createdAt: -1 } },
    ]);

    let units = 0, gross = 0, net = 0, cost = 0;
    const recent = [];
    for (const bill of bills) {
      for (const it of bill.items) {
        const inclusive = bill.vatEnabled && bill.priceMode === "inclusive" && it.vatClass === "standard";
        const lineNet = inclusive ? it.lineTotal / (1 + (bill.vatRate || 0) / 100) : it.lineTotal;
        const unitCost = it.costPriceAtSale != null ? it.costPriceAtSale : avgCost;
        units += it.quantity; gross += it.lineTotal; net += lineNet; cost += unitCost * it.quantity;
        if (recent.length < 10) {
          recent.push({ billId: bill.billId, at: bill.paidAt || bill.createdAt, cashier: bill.cashierName || "", quantity: it.quantity, unitPrice: it.unitPrice });
        }
      }
    }

    res.json({
      productId: String(pid),
      avgCost: r4(avgCost),
      deliveries: allDeliveries,
      sales: { days: 30, units: r4(units), gross: r2(gross), net: r2(net), cost: r2(cost), profit: r2(net - cost), recent },
      details: {
        vatClass: product.vatClass, perishable: product.perishable, maxLevel: product.maxLevel,
        reorderLevel: product.reorderLevel, description: product.description,
      },
    });
  } catch (error) { next(error); }
};
