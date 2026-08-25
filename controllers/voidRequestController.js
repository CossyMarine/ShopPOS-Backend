// controllers/voidRequestController.js
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import VoidRequest from "../models/VoidRequest.js";
import Product from "../models/Product.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// Reverses a FIFO deduction — adds the quantity back as a new batch at the
// original unit cost where known, so voiding a sale doesn't silently lose
// stock. `lines` is either the whole receipt (full void) or a subset
// (partial void).
const restockItems = async (lines, billId, restockedBy) => {
  for (const line of lines) {
    if (!line.productId) continue; // manually-entered fallback line, nothing to restock
    const product = await Product.findById(line.productId);
    if (!product) continue;
    product.batches.push({
      quantity: line.quantity,
      costPerUnit: line.unitPrice,
      expiryDate: null,
      receivedBy: restockedBy,
      supplierNote: `Restocked from voided bill ${billId}`,
    });
    await product.save();
  }
};

// @desc    Get all pending void requests, with receipt + requester populated
//          (Super Admin can omit ?branch= to see every branch)
// @route   GET /api/void-requests?branch=
// @access  Protected — branchManager, admin
export const getVoidRequests = async (req, res, next) => {
  try {
    logStart("voidRequest", "Loading pending void requests", { branch: req.query.branch || "all" });

    const voidRequests = await VoidRequest.find({ status: "pending" })
      .populate({
        path: "receipt",
        ...(req.query.branch ? { match: { branch: req.query.branch } } : {}),
      })
      .populate("requestedBy", "fullName")
      .sort({ createdAt: -1 });

    const filtered = voidRequests.filter((v) => v.receipt);

    logSuccess("voidRequest", "Pending void requests loaded", { count: filtered.length });
    res.json(filtered);
  } catch (error) {
    next(error);
  }
};

// @desc    Request a receipt — or specific line items on it — be voided.
//          Body: { receiptId, reason, items? }
//          `items` is an optional array of indices into receipt.items.
//          Omit it (or include every index) to request voiding the whole bill.
// @route   POST /api/void-requests
// @access  Protected — cashier, branchManager, admin
export const createVoidRequest = async (req, res, next) => {
  try {
    const { receiptId, reason, items } = req.body;
    const requestedBy = req.user._id;

    logStart("voidRequest", "Creating void request", { receiptId, requestedBy });

    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: "A reason is required" });
    }

    const receipt = await Receipt.findById(receiptId);
    if (!receipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (receipt.status === "voided") {
      return res.status(400).json({ message: "Receipt is already voided" });
    }

    const existingPending = await VoidRequest.findOne({ receipt: receiptId, status: "pending" });
    if (existingPending) {
      return res.status(400).json({ message: "A void request for this bill is already pending manager approval" });
    }

    let voidType = "full";
    let voidItems = receipt.items.map((line, index) => ({
      index,
      productId: line.productId || null,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    }));

    if (Array.isArray(items) && items.length > 0 && items.length < receipt.items.length) {
      const indices = [...new Set(items.map((i) => Number(i)))].filter(
        (i) => Number.isInteger(i) && i >= 0 && i < receipt.items.length
      );
      if (indices.length === 0) {
        return res.status(400).json({ message: "No valid items selected to void" });
      }
      voidType = "partial";
      voidItems = indices.map((index) => {
        const line = receipt.items[index];
        return {
          index,
          productId: line.productId || null,
          productName: line.productName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        };
      });
    }

    const voidRequest = await VoidRequest.create({
      receipt: receiptId,
      requestedBy,
      reason: reason.trim(),
      voidType,
      voidItems,
    });

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("voidRequest:created", voidRequest);

    logSuccess("voidRequest", "Void request created", { voidRequestId: voidRequest._id, voidType });
    res.status(201).json({ message: "Void request submitted", voidRequest });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve a void request — voids the whole receipt, or (for a
//          partial request) removes only the requested line items,
//          restocks them, and recalculates the bill's subtotal/status.
// @route   PATCH /api/void-requests/:id/approve
// @access  Protected — branchManager, admin
export const approveVoidRequest = async (req, res, next) => {
  const { id } = req.params;
  const reviewedBy = req.user._id;

  const session = await mongoose.startSession();
  let voidRequest, receipt;

  try {
    logStart("voidRequest", "Approving void request", { voidRequestId: id, reviewedBy });

    await session.withTransaction(async () => {
      voidRequest = await VoidRequest.findById(id).session(session);
      if (!voidRequest) throw notFound("Void request");
      if (voidRequest.status !== "pending") {
        // Not pending — nothing to roll back yet, so it's safe to throw a
        // plain validation error rather than an aborted transaction.
        throw badRequest(`Void request is already ${voidRequest.status}`);
      }

      receipt = await Receipt.findById(voidRequest.receipt).session(session);
      if (!receipt) throw notFound("Receipt");

      voidRequest.status = "approved";
      voidRequest.reviewedBy = reviewedBy;
      voidRequest.reviewedAt = new Date();
      await voidRequest.save({ session });

      if (voidRequest.voidType === "partial" && voidRequest.voidItems.length < receipt.items.length) {
        const voidedIndices = new Set(voidRequest.voidItems.map((v) => v.index));

        await restockItems(voidRequest.voidItems, receipt.billId, reviewedBy, { session });

        const remainingItems = receipt.items.filter((_, idx) => !voidedIndices.has(idx));
        const voidedTotal = voidRequest.voidItems.reduce((sum, v) => sum + v.lineTotal, 0);
        const newSubtotal = Number(remainingItems.reduce((sum, i) => sum + i.lineTotal, 0).toFixed(2));

        receipt.items = remainingItems;
        receipt.subtotal = newSubtotal;

        if (remainingItems.length === 0) {
          receipt.status = "voided";
        } else if (receipt.amountPaid != null) {
          const newAmountPaid = Math.max(0, Number((receipt.amountPaid - voidedTotal).toFixed(2)));
          receipt.amountPaid = newAmountPaid;
          receipt.status = newAmountPaid >= newSubtotal ? "paid" : newAmountPaid > 0 ? "partial" : "unpaid";
        }

        await receipt.save({ session });
        await Order.findByIdAndUpdate(receipt.order, { items: remainingItems, subtotal: newSubtotal }, { session });
      } else {
        receipt.status = "voided";
        await receipt.save({ session });
        await restockItems(receipt.items, receipt.billId, reviewedBy, { session });
      }
    });
  } catch (error) {
    await session.endSession();
    return next(error);
  }
  await session.endSession();

  // Emit only after commit — see reasoning in createOrder above.
  const io = req.app.get("io");
  io.to(`branch:${receipt.branch}`).emit("voidRequest:approved", voidRequest);
  io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);

  logSuccess("voidRequest", "Void request approved", { voidRequestId: id, voidType: voidRequest.voidType });
  res.json({ message: "Void request approved", voidRequest, receipt });
};
