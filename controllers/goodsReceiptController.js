// controllers/goodsReceiptController.js
import mongoose from "mongoose";
import Product from "../models/Product.js";
import Supplier from "../models/Supplier.js";
import GoodsReceipt from "../models/GoodsReceipt.js";
import Counter from "../models/Counter.js";
import AuditLog from "../models/AuditLog.js";
import AdminSettings from "../models/AdminSettings.js"; // CHANGED: VAT settings
import { calcDelivery, stockOf, baseAbbr, r2, r4 } from "../utils/receivingMath.js"; // CHANGED: VAT_RATE no longer needed
import { AppError, badRequest, notFound, forbidden } from "../utils/AppError.js";

// @route POST /api/goods-receipts   @access storekeeper, branchManager, admin
export const createGoodsReceipt = async (req, res, next) => {
  let session;
  try {
    const b = req.body || {};
    const branch = b.branch;
    if (!branch) throw badRequest("branch is required");
    if (!Array.isArray(b.lines) || !b.lines.length) throw badRequest("Add at least one product");

    const ids = b.lines.map((l) => String(l.product));
    if (new Set(ids).size !== ids.length) throw badRequest("A product appears twice in this delivery");

    const products = await Product.find({ _id: { $in: ids }, branch }).populate("unit", "name abbreviation");
    if (products.length !== ids.length) throw badRequest("One or more products were not found in this branch");
    products.forEach((p) => { if (!p.isActive) throw badRequest(`${p.name} is archived`); });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    // CHANGED: VAT always comes from Admin Settings, never from the client.
    // - rate: the configured rate
    // - not VAT-registered: input VAT can't be claimed, so it always goes into cost
    const vatCfg = (await AdminSettings.getSettings()).vat || {};
    const registered = !!vatCfg.enabled;
    const vatRate = Number(vatCfg.rate) > 0 ? Number(vatCfg.rate) : 16;
    const vatNR = registered ? !!b.vatNR : true;

    const calc = calcDelivery({ ...b, vatRate, vatNR }, byId); // CHANGED
    if (calc.errors.length) throw badRequest(calc.errors[0], { errors: calc.errors });

    // Supplier: pick from list, match by typed name, or (optionally) create
    let supplier = null;
    let supplierName = String(b.supplierName || "").trim();
    if (b.supplier) {
      supplier = await Supplier.findOne({ _id: b.supplier, branch });
      if (!supplier) throw badRequest("Supplier not found");
      supplierName = supplier.name;
    } else if (supplierName) {
      supplier = await Supplier.findOne({ branch, nameKey: supplierName.toLowerCase() });
      if (supplier) supplierName = supplier.name;
    }

    // Same invoice from same supplier received before?
    const invoice = String(b.invoice || "").trim();
    if (invoice && !b.allowDuplicate) {
      const dup = await GoodsReceipt.findOne({
        branch, invoiceKey: invoice.toLowerCase(), supplierKey: supplierName.toLowerCase(),
      }).select("no");
      if (dup) throw new AppError(`Invoice ${invoice} from this supplier was already received as ${dup.no}`, 409, { duplicate: dup.no });
    }

    let receipt;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const now = new Date();
      const day = now.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }).replace(/-/g, "");
      const ctr = await Counter.findOneAndUpdate(
        { name: `grn:${branch}:${day}` }, { $inc: { seq: 1 } }, { upsert: true, new: true, session }
      );
      const no = `GRN-${day}-${String(ctr.seq).padStart(3, "0")}`;
      const receiptId = new mongoose.Types.ObjectId();

      if (!supplier && supplierName && b.createSupplier) {
        [supplier] = await Supplier.create([{ name: supplierName, branch }], { session });
      }

      const lines = [], audits = [];
      for (const { line, p, c } of calc.L) {
        const before = stockOf(p);
        const note = [supplierName, invoice && `Inv ${invoice}`].filter(Boolean).join(" · ");

        p.batches.push({
          quantity: c.added,
          costPerUnit: r4(c.eff),
          expiryDate: line.expiryDate || null,
          receivedAt: now,
          receivedBy: req.user._id,
          supplierNote: note,
          batchNo: String(line.batchNo || "").trim(),
          receipt: receiptId,
          boughtAs: c.bought,
        });

        // Selling prices updated on the same screen
        const np = Number(line.newPrice);
        if (np > 0 && np !== p.sellingPrice) {
          audits.push({ field: "sellingPrice", prev: p.sellingPrice, next: np, p });
          p.sellingPrice = np;
        }
        const pp = line.packPrices || {};
        p.packs.forEach((pk) => {
          const k = String(pk._id);
          if (!(k in pp)) return;
          const v = Number(pp[k]) > 0 ? Number(pp[k]) : null;
          if (v !== pk.price) audits.push({ field: `packPrice:${pk.name}`, prev: pk.price, next: v, p });
          pk.price = v;
        });
        const big = [...p.packs].sort((x, y) => y.qty - x.qty)[0];
        if (big) p.casePrice = big.price;
        if (!p.supplier && supplier) p.supplier = supplier._id;

        await p.save({ session });

        lines.push({
          product: p._id, name: p.name, base: baseAbbr(p),
          bought: c.bought, boughtText: c.bought.map((x) => `${x.qty} ${x.name}`).join(" + "),
          receivedBase: c.recv, rejectedBase: c.rej, freeBase: c.freeBase, addedBase: c.added,
          stockBefore: before, stockAfter: before + c.added,
          unitPrice: r4(c.unitPrice), gross: r2(c.gross), discount: r2(c.disc), net: r2(c.net), effCost: r4(c.eff),
          vatClass: c.vatClass, exVat: r2(c.exVat), vat: r2(c.vat), // CHANGED: per-line VAT
          discounts: c.discounts.map((d) => ({ ...d, amount: r2(d.amount) })),
          expiryDate: line.expiryDate || null, batchNo: String(line.batchNo || "").trim(),
          newSellingPrice: p.sellingPrice,
        });
      }

      const termsDays = parseInt(b.terms, 10);
      const delivery = b.deliveryDate ? new Date(b.deliveryDate) : now;
      const dueDate = termsDays > 0 ? new Date(delivery.getTime() + termsDays * 864e5) : null;

      [receipt] = await GoodsReceipt.create([{
        _id: receiptId, no, branch,
        supplier: supplier?._id || null, supplierName, supplierKey: supplierName.toLowerCase(),
        invoice, invoiceKey: invoice.toLowerCase(), po: b.po || "",
        supplierPin: supplier?.kraPin || "",              // CHANGED: for VAT claims
        etimsNo: String(b.etimsNo || "").trim(),          // CHANGED: for VAT claims
        deliveryDate: delivery, dueDate, driver: b.driver || "", terms: b.terms || "Cash on delivery",
        receivedBy: req.user._id, receivedByName: b.receivedByName || req.user.fullName || "", note: b.note || "",
        discPct: Number(b.discPct) || 0, discAmt: Number(b.discAmt) || 0,
        // CHANGED: stores the real rate used and the enforced recoverable flag
        vat: { on: !!b.vatOn, mode: b.vatMode === "incl" ? "incl" : "excl", notRecoverable: vatNR, rate: vatRate },
        totals: calc.totals, lines,
      }], { session });

      const docs = [
        { entityType: "GoodsReceipt", entityId: receiptId, action: "created", performedBy: req.user._id, branch,
          details: { no, supplierName, invoice, total: calc.totals.total, lines: lines.length } },
        ...audits.map((a) => ({ entityType: "Product", entityId: a.p._id, action: "priceChanged", performedBy: req.user._id, branch,
          details: { productName: a.p.name, field: a.field, previousValue: a.prev, newValue: a.next, receipt: no } })),
      ];
      await AuditLog.create(docs, { session, ordered: true });
    });

    res.status(201).json(receipt);
  } catch (error) {
    next(error);
  } finally {
    if (session) session.endSession();
  }
};

// @route GET /api/goods-receipts?branch=&supplier=&q=&limit=
export const getGoodsReceipts = async (req, res, next) => {
  try {
    const f = {};
    if (req.query.branch) f.branch = req.query.branch;
    if (req.query.supplier) f.supplier = req.query.supplier;
    if (req.query.q) {
      const q = String(req.query.q).trim().toLowerCase();
      f.$or = [{ invoiceKey: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }, { supplierKey: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }];
    }
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const list = await GoodsReceipt.find(f).sort({ createdAt: -1 }).limit(limit).populate("receivedBy", "fullName");
    res.json(list);
  } catch (error) { next(error); }
};

// @route GET /api/goods-receipts/:id
export const getGoodsReceipt = async (req, res, next) => {
  try {
    const r = await GoodsReceipt.findById(req.params.id).populate("receivedBy", "fullName");
    if (!r) throw notFound("Delivery");
    if (!req.user.isAdmin && String(r.branch) !== String(req.user.branch)) throw forbidden("You can only view your own branch");
    res.json(r);
  } catch (error) { next(error); }
};
