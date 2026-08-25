// controllers/stockTransferController.js
import mongoose from "mongoose";
import StockTransfer from "../models/StockTransfer.js";
import Product from "../models/Product.js";
import Branch from "../models/Branch.js";
import AuditLog from "../models/AuditLog.js";
import { deductStockFIFO } from "../utils/productStock.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// Weighted-average cost per "each" unit across a product's remaining batches.
// Used as a fallback price only when a line has no unitCostAtSend yet.
const avgCostPerEach = (product) => {
  const batches = product.batches || [];
  const totalQty = batches.reduce((s, b) => s + b.quantity, 0);
  if (!totalQty) return 0;
  const totalCost = batches.reduce((s, b) => s + b.quantity * b.costPerUnit, 0);
  return totalCost / totalQty;
};

// A staff member may act on a transfer only if it touches their own branch —
// as the source (dispatch) or destination (receive). Admins bypass entirely.
// Distinct from the existing `sameBranch` middleware, which only knows how
// to check a single `branch` field — transfers always have two.
const canActOnBranch = (user, branchId) => {
  if (user.isAdmin) return true;
  return user.branch && String(user.branch) === String(branchId);
};

// @desc    Create a draft transfer — plans what will move, touches no stock yet.
// @route   POST /api/stock-transfers
// @body    { fromBranch, toBranch, lines: [{ product, quantitySent }], note? }
// @access  Protected — storekeeper, branchManager, admin (must belong to fromBranch)
export const createStockTransfer = async (req, res, next) => {
  try {
    const { fromBranch, toBranch, lines, note } = req.body;
    logStart("stockTransfer", "Creating draft transfer", { fromBranch, toBranch, lineCount: lines?.length });

    if (!fromBranch || !toBranch) {
      return res.status(400).json({ message: "fromBranch and toBranch are required" });
    }
    if (String(fromBranch) === String(toBranch)) {
      return res.status(400).json({ message: "fromBranch and toBranch must be different" });
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines must be a non-empty array" });
    }
    if (!canActOnBranch(req.user, fromBranch)) {
      return res.status(403).json({ message: "You can only create transfers out of your own branch" });
    }

    const [sourceBranch, destBranch] = await Promise.all([
      Branch.findById(fromBranch),
      Branch.findById(toBranch),
    ]);
    if (!sourceBranch) return res.status(404).json({ message: "Source branch not found" });
    if (!destBranch) return res.status(404).json({ message: "Destination branch not found" });

    const productIds = lines.map((l) => l.product);
    const products = await Product.find({ _id: { $in: productIds }, branch: fromBranch });
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const builtLines = [];
    for (const line of lines) {
      const product = productMap.get(String(line.product));
      if (!product) {
        return res.status(400).json({ message: `Product ${line.product} not found at source branch` });
      }
      const qty = Number(line.quantitySent);
      if (!qty || qty <= 0) {
        return res.status(400).json({ message: `quantitySent for ${product.name} must be greater than 0` });
      }
      if (qty > (product.currentStock ?? 0)) {
        return res.status(400).json({
          message: `Not enough stock of ${product.name} to plan this transfer (have ${product.currentStock}, wanted ${qty})`,
        });
      }
      builtLines.push({
        product: product._id,
        productName: product.name,
        barcode: product.barcode || null,
        quantitySent: qty,
      });
    }

    const transfer = await StockTransfer.create({
      fromBranch,
      toBranch,
      lines: builtLines,
      initiatedBy: req.user._id,
      note: note || "",
    });

    const io = req.app.get("io");
    io.to(`branch:${fromBranch}`).emit("stockTransfer:created", transfer);
    io.to(`branch:${toBranch}`).emit("stockTransfer:created", transfer);

    logSuccess("stockTransfer", "Draft transfer created", { transferId: transfer._id, lineCount: builtLines.length });
    res.status(201).json(transfer);
  } catch (error) {
    next(error);
  }
};

// @desc    List transfers — defaults to open ones (draft/in_transit) unless
//          a status is explicitly requested. `direction` filters to only
//          outgoing or incoming relative to `branch`.
// @route   GET /api/stock-transfers?branch=&direction=outgoing|incoming&status=
// @access  Protected — storekeeper, branchManager, admin
export const getStockTransfers = async (req, res, next) => {
  try {
    const { branch, direction, status } = req.query;
    const filter = {};

    if (branch) {
      if (direction === "outgoing") filter.fromBranch = branch;
      else if (direction === "incoming") filter.toBranch = branch;
      else filter.$or = [{ fromBranch: branch }, { toBranch: branch }];
    }

    if (status) filter.status = status;
    else filter.status = { $in: ["draft", "in_transit"] };

    const transfers = await StockTransfer.find(filter)
      .populate("fromBranch", "name isWarehouse")
      .populate("toBranch", "name isWarehouse")
      .populate("initiatedBy", "fullName")
      .populate("dispatchedBy", "fullName")
      .populate("receivedBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(transfers);
  } catch (error) {
    next(error);
  }
};

// @desc    Get one transfer with full line detail
// @route   GET /api/stock-transfers/:id
// @access  Protected — storekeeper, branchManager, admin
export const getStockTransferById = async (req, res, next) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id)
      .populate("fromBranch", "name isWarehouse")
      .populate("toBranch", "name isWarehouse")
      .populate("initiatedBy", "fullName")
      .populate("dispatchedBy", "fullName")
      .populate("receivedBy", "fullName");
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });
    res.json(transfer);
  } catch (error) {
    next(error);
  }
};

// @desc    Dispatch a draft transfer — deducts each line FIFO from the
//          source branch's product and stamps the weighted-average cost
//          that travels with the stock. This is the moment it leaves the
//          shelf, so it's the moment it leaves the count.
// @route   PATCH /api/stock-transfers/:id/dispatch
// @access  Protected — storekeeper, branchManager, admin (must belong to fromBranch)
export const dispatchStockTransfer = async (req, res, next) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });
    if (transfer.status !== "draft") {
      return res.status(400).json({ message: `Cannot dispatch — already ${transfer.status}` });
    }
    if (!canActOnBranch(req.user, transfer.fromBranch)) {
      return res.status(403).json({ message: "Only the source branch can dispatch this transfer" });
    }

    logStart("stockTransfer", "Dispatching transfer", { transferId: transfer._id });

    const io = req.app.get("io");

    for (const line of transfer.lines) {
      const product = await Product.findById(line.product);
      if (!product) {
        return res.status(400).json({ message: `Product ${line.productName} no longer exists — cannot dispatch` });
      }
      if (line.quantitySent > (product.currentStock ?? 0)) {
        return res.status(400).json({
          message: `Stock for ${product.name} has changed since this transfer was planned (have ${product.currentStock}, need ${line.quantitySent}). Adjust or cancel the transfer.`,
        });
      }
      const { avgCostPerUnit } = await deductStockFIFO(product, line.quantitySent);
      line.unitCostAtSend = Number(avgCostPerUnit.toFixed(4));

      io.to(`branch:${transfer.fromBranch}`).emit("product:updated", product);
    }

    transfer.status = "in_transit";
    transfer.dispatchedBy = req.user._id;
    transfer.dispatchedAt = new Date();
    await transfer.save();

    await AuditLog.create({
      entityType: "StockTransfer",
      entityId: transfer._id,
      action: "dispatched",
      performedBy: req.user._id,
      branch: transfer.fromBranch,
      details: {
        toBranch: transfer.toBranch,
        lines: transfer.lines.map((l) => ({
          productName: l.productName,
          quantitySent: l.quantitySent,
          unitCostAtSend: l.unitCostAtSend,
        })),
      },
    });

    io.to(`branch:${transfer.fromBranch}`).emit("stockTransfer:dispatched", transfer);
    io.to(`branch:${transfer.toBranch}`).emit("stockTransfer:dispatched", transfer);

    logSuccess("stockTransfer", "Transfer dispatched", { transferId: transfer._id });
    res.json(transfer);
  } catch (error) {
    next(error);
  }
};

// @desc    Receive an in-transit transfer at the destination branch. Matches
//          each line to an existing product at the destination by barcode
//          (or name as fallback) — creates a new product there if nothing
//          matches, cloning the catalog fields from the source product so
//          it doesn't land as a bare name with no price/unit/category.
//          Any received quantity below what was sent is recorded as a
//          discrepancy on the line, never silently absorbed.
// @route   PATCH /api/stock-transfers/:id/receive
// @body    { lines: [{ product, quantityReceived, discrepancyNote? }] }
//          (product here refers to the SOURCE product id, i.e. line.product
//          on the transfer — lines you omit default to full quantitySent)
// @access  Protected — storekeeper, branchManager, admin (must belong to toBranch)
export const receiveStockTransfer = async (req, res, next) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });
    if (transfer.status !== "in_transit") {
      return res.status(400).json({ message: `Cannot receive — status is ${transfer.status}, not in_transit` });
    }
    if (!canActOnBranch(req.user, transfer.toBranch)) {
      return res.status(403).json({ message: "Only the destination branch can receive this transfer" });
    }

    logStart("stockTransfer", "Receiving transfer", { transferId: transfer._id });

    const incoming = req.body.lines;
    const overrides = new Map(
      Array.isArray(incoming) ? incoming.map((l) => [String(l.product), l]) : []
    );

    const io = req.app.get("io");
    let anyDiscrepancy = false;

    for (const line of transfer.lines) {
      const override = overrides.get(String(line.product));
      const quantityReceived = override?.quantityReceived !== undefined
        ? Number(override.quantityReceived)
        : line.quantitySent; // default: assume full receipt if not specified

      if (quantityReceived < 0) {
        return res.status(400).json({ message: `quantityReceived for ${line.productName} cannot be negative` });
      }

      const sourceProduct = await Product.findById(line.product);

      // Match at destination by barcode first (most reliable), then name.
      let destProduct = null;
      if (line.barcode) {
        destProduct = await Product.findOne({ branch: transfer.toBranch, barcode: line.barcode });
      }
      if (!destProduct) {
        destProduct = await Product.findOne({
          branch: transfer.toBranch,
          name: { $regex: `^${line.productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
        });
      }

      if (!destProduct) {
        if (!sourceProduct) {
          return res.status(400).json({
            message: `No matching product for ${line.productName} at destination, and the source product record was deleted — cannot auto-create it. Add it manually first.`,
          });
        }
        destProduct = await Product.create({
          name: sourceProduct.name,
          barcode: sourceProduct.barcode || undefined, // safe now that barcode uniqueness is scoped per branch
          category: sourceProduct.category,
          vatClass: sourceProduct.vatClass,
          unit: sourceProduct.unit,
          packSize: sourceProduct.packSize,
          caseLabel: sourceProduct.caseLabel,
          sellingPrice: sourceProduct.sellingPrice,
          casePrice: sourceProduct.casePrice,
          reorderLevel: sourceProduct.reorderLevel,
          imageUrl: sourceProduct.imageUrl,
          branch: transfer.toBranch,
          batches: [],
        });
      }

      if (quantityReceived > 0) {
        destProduct.batches.push({
          quantity: quantityReceived,
          costPerUnit: line.unitCostAtSend ?? avgCostPerEach(sourceProduct || {}),
          expiryDate: null,
          receivedBy: req.user._id,
          supplierNote: `Stock transfer #${transfer._id} from branch ${transfer.fromBranch}`,
        });
        await destProduct.save();
        io.to(`branch:${transfer.toBranch}`).emit("product:updated", destProduct);
      }

      line.quantityReceived = quantityReceived;
      line.destinationProduct = destProduct._id;
      if (override?.discrepancyNote) line.discrepancyNote = override.discrepancyNote;

      if (quantityReceived !== line.quantitySent) {
        anyDiscrepancy = true;
        if (!line.discrepancyNote) {
          line.discrepancyNote = quantityReceived < line.quantitySent
            ? `Short by ${line.quantitySent - quantityReceived}`
            : `Over by ${quantityReceived - line.quantitySent}`;
        }
      }
    }

    transfer.status = "completed";
    transfer.receivedBy = req.user._id;
    transfer.receivedAt = new Date();
    await transfer.save();

    await AuditLog.create({
      entityType: "StockTransfer",
      entityId: transfer._id,
      action: "received",
      performedBy: req.user._id,
      branch: transfer.toBranch,
      details: {
        fromBranch: transfer.fromBranch,
        anyDiscrepancy,
        lines: transfer.lines.map((l) => ({
          productName: l.productName,
          quantitySent: l.quantitySent,
          quantityReceived: l.quantityReceived,
          discrepancyNote: l.discrepancyNote,
        })),
      },
    });

    io.to(`branch:${transfer.fromBranch}`).emit("stockTransfer:completed", transfer);
    io.to(`branch:${transfer.toBranch}`).emit("stockTransfer:completed", transfer);

    logSuccess("stockTransfer", "Transfer received", { transferId: transfer._id, anyDiscrepancy });
    res.json(transfer);
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel a transfer. A draft cancels with no side effects — nothing
//          was ever deducted. An in-transit transfer restocks the source
//          branch, at the exact cost it left at, since that stock is
//          otherwise unaccounted for in the system.
// @route   PATCH /api/stock-transfers/:id/cancel
// @body    { reason? }
// @access  Protected — branchManager, admin
export const cancelStockTransfer = async (req, res, next) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });
    if (!["draft", "in_transit"].includes(transfer.status)) {
      return res.status(400).json({ message: `Cannot cancel — already ${transfer.status}` });
    }
    if (!canActOnBranch(req.user, transfer.fromBranch) && !canActOnBranch(req.user, transfer.toBranch)) {
      return res.status(403).json({ message: "You can only cancel transfers touching your own branch" });
    }

    logStart("stockTransfer", "Cancelling transfer", { transferId: transfer._id, status: transfer.status });

    const io = req.app.get("io");

    if (transfer.status === "in_transit") {
      for (const line of transfer.lines) {
        const product = await Product.findById(line.product);
        if (!product) continue; // source product deleted — stock is unrecoverable, note stays in the log
        product.batches.push({
          quantity: line.quantitySent,
          costPerUnit: line.unitCostAtSend ?? 0,
          expiryDate: null,
          receivedBy: req.user._id,
          supplierNote: `Restocked — transfer #${transfer._id} cancelled in transit`,
        });
        await product.save();
        io.to(`branch:${transfer.fromBranch}`).emit("product:updated", product);
      }
    }

    transfer.status = "cancelled";
    transfer.note = req.body.reason
      ? `${transfer.note ? transfer.note + " | " : ""}Cancelled: ${req.body.reason}`
      : transfer.note;
    await transfer.save();

    await AuditLog.create({
      entityType: "StockTransfer",
      entityId: transfer._id,
      action: "cancelled",
      performedBy: req.user._id,
      branch: transfer.fromBranch,
      details: { toBranch: transfer.toBranch, reason: req.body.reason || "" },
    });

    io.to(`branch:${transfer.fromBranch}`).emit("stockTransfer:cancelled", transfer);
    io.to(`branch:${transfer.toBranch}`).emit("stockTransfer:cancelled", transfer);

    logSuccess("stockTransfer", "Transfer cancelled", { transferId: transfer._id });
    res.json(transfer);
  } catch (error) {
    next(error);
  }
};
