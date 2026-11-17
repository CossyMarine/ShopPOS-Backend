// controllers/supplierController.js
import Supplier from "../models/Supplier.js";
import GoodsReceipt from "../models/GoodsReceipt.js";
import Product from "../models/Product.js";
import { badRequest, notFound, forbidden } from "../utils/AppError.js";

const FIELDS = ["name", "contactPerson", "phone", "email", "address", "kraPin", "paymentTerms", "note", "isActive"];
const mine = (req, s) => req.user.isAdmin || String(s.branch) === String(req.user.branch);

// GET /api/suppliers?branch=&status=active|archived|all
export const getSuppliers = async (req, res, next) => {
  try {
    const f = {};
    if (req.query.branch) f.branch = req.query.branch;
    if (req.query.status === "archived") f.isActive = false;
    else if (req.query.status !== "all") f.isActive = true;
    const list = await Supplier.find(f).sort({ name: 1 }).lean();
    const stats = await GoodsReceipt.aggregate([
      { $match: { supplier: { $in: list.map((s) => s._id) } } },
      { $group: { _id: "$supplier", count: { $sum: 1 }, total: { $sum: "$totals.total" }, last: { $max: "$createdAt" } } },
    ]);
    const m = new Map(stats.map((s) => [String(s._id), s]));
    res.json(list.map((s) => ({ ...s, purchases: m.get(String(s._id)) || { count: 0, total: 0, last: null } })));
  } catch (e) { next(e); }
};

// POST /api/suppliers
export const createSupplier = async (req, res, next) => {
  try {
    if (!req.body.name?.trim()) throw badRequest("Supplier name is required");
    if (!req.body.branch) throw badRequest("branch is required");
    const data = { branch: req.body.branch };
    FIELDS.forEach((k) => { if (req.body[k] !== undefined) data[k] = req.body[k]; });
    const s = await Supplier.create(data);
    res.status(201).json(s);
  } catch (e) {
    if (e.code === 11000) return next(badRequest("A supplier with that name already exists"));
    next(e);
  }
};

// PUT /api/suppliers/:id  (also used to archive / restore with { isActive })
export const updateSupplier = async (req, res, next) => {
  try {
    const s = await Supplier.findById(req.params.id);
    if (!s) throw notFound("Supplier");
    if (!mine(req, s)) throw forbidden("You can only edit your own branch");
    FIELDS.forEach((k) => { if (req.body[k] !== undefined) s[k] = req.body[k]; });
    if (!s.name?.trim()) throw badRequest("Supplier name is required");
    await s.save();
    res.json(s);
  } catch (e) {
    if (e.code === 11000) return next(badRequest("A supplier with that name already exists"));
    next(e);
  }
};

// DELETE /api/suppliers/:id  — only if never used; otherwise archive
export const deleteSupplier = async (req, res, next) => {
  try {
    const s = await Supplier.findById(req.params.id);
    if (!s) throw notFound("Supplier");
    if (!mine(req, s)) throw forbidden("You can only delete from your own branch");
    const [used, linked] = await Promise.all([
      GoodsReceipt.exists({ supplier: s._id }),
      Product.exists({ supplier: s._id }),
    ]);
    if (used || linked) throw badRequest("This supplier has deliveries or products linked to it. Archive it instead.");
    await s.deleteOne();
    res.json({ message: "Supplier deleted" });
  } catch (e) { next(e); }
};
