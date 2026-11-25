// controllers/voidRequestController.js
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import VoidRequest from "../models/VoidRequest.js";
import CreditRecord from "../models/CreditRecord.js";
import { restockItems } from "../utils/productStock.js";
import { buildOrderVat } from "../utils/vat.js";
import { notFound, badRequest } from "../utils/AppError.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

const round2 = (n) => Number(Number(n).toFixed(2));

// True if the bill was ever given on credit (still owing OR since settled).
// Such bills carry a "credit" entry in payments[] for the full amount, so they
// can only be voided in full — removing single items would leave that entry
// and the credit record out of step with the bill.
const hasCreditEntry = (receipt) =>
  Array.isArray(receipt.payments) && receipt.payments.some((p) => p.method === "credit");

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

    // amountPaid is money received only (the credit entry is not counted), so
    // > 0 means the customer has already paid something towards this credit.
    if (receipt.status === "credit" && (receipt.amountPaid || 0) > 0) {
      return res.status(400).json({ message: "This credit bill already has payments recorded, so it can't be voided" });
    }
    const isPartialRequest = Array.isArray(items) && items.length > 0 && items.length < receipt.items.length;
    if (isPartialRequest && (receipt.status === "credit" || hasCreditEntry(receipt))) {
      return res.status(400).json({ message: "Bills given on credit can only be voided in full" });
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

    if (isPartialRequest) {
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
//          restocks them, and recalculates the bill's subtotal, VAT, total
//          due and paid/partial/unpaid status.
// @route   PATCH /api/void-requests/:id/approve
// @access  Protected — branchManager, admin
export const approveVoidRequest = async (req, res, next) => {
  const { id } = req.params;
  const reviewedBy = req.user._id;

  let session;
  let voidRequest, receipt;

  try {
    // Inside the try so a failure here reaches next(error) instead of
    // becoming an unhandled rejection that leaves the request hanging.
    session = await mongoose.startSession();

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

      if (receipt.status === "credit" && (receipt.amountPaid || 0) > 0) {
        throw badRequest("A payment was recorded on this credit bill after the request. It can't be voided.");
      }

      const isPartial = voidRequest.voidType === "partial" && voidRequest.voidItems.length < receipt.items.length;

      // The bill may have gone on credit after a partial request was made.
      if (isPartial && (receipt.status === "credit" || hasCreditEntry(receipt))) {
        throw badRequest("This bill was given on credit, so it can only be voided in full.");
      }

      const now = new Date();
      const restockNote = `Restocked from voided bill ${receipt.billId}`;

      voidRequest.status = "approved";
      voidRequest.reviewedBy = reviewedBy;
      voidRequest.reviewedAt = now;
      await voidRequest.save({ session });

      if (isPartial) {
        const voidedIndices = new Set(voidRequest.voidItems.map((v) => v.index));

        await restockItems(voidRequest.voidItems, restockNote, reviewedBy, { session });

        const remainingItems = receipt.items.filter((_, idx) => !voidedIndices.has(idx));
        const oldTotalDue = receipt.totalDue;

        // Rebuild the totals the same way checkout does, using the VAT
        // settings stored ON THIS RECEIPT (not today's settings, which may
        // have changed since the sale). With VAT off this reduces to the
        // plain sum of the remaining line totals.
        const vat = buildOrderVat(remainingItems, {
          enabled: receipt.vatEnabled,
          rate: receipt.vatRate,
          priceMode: receipt.priceMode,
        });
        const newSubtotal = round2(vat.subtotal);
        const newVatAmount = round2(vat.vatAmount);
        const newTotalDue = round2(vat.totalDue);

        receipt.items = remainingItems;
        receipt.subtotal = newSubtotal;
        receipt.vatAmount = newVatAmount;
        receipt.totalDue = newTotalDue;

        if (remainingItems.length === 0) {
          receipt.status = "voided";
          receipt.voidedAt = now;
        } else if (receipt.amountPaid != null) {
          // What the customer owes dropped by the VAT-inclusive value of the
          // voided lines, so that is what comes off amountPaid — not the raw
          // line totals, which would leave VAT behind.
          const reduction = round2(oldTotalDue - newTotalDue);
          const newAmountPaid = Math.max(0, round2(receipt.amountPaid - reduction));
          receipt.amountPaid = newAmountPaid;
          receipt.status = newAmountPaid >= newTotalDue ? "paid" : newAmountPaid > 0 ? "partial" : "unpaid";
        }

        await receipt.save({ session });
        await Order.findByIdAndUpdate(
          receipt.order,
          { items: remainingItems, subtotal: newSubtotal, vatAmount: newVatAmount, totalDue: newTotalDue },
          { session }
        );
      } else {
        receipt.status = "voided";
        receipt.voidedAt = now;
        // A cancelled credit sale must stop counting as "credit given" in the
        // payment totals (which read payments[] regardless of receipt status).
        // The void request and the credit record keep the audit trail.
        receipt.payments = receipt.payments.filter((p) => p.method !== "credit");
        await receipt.save({ session });
        await restockItems(receipt.items, restockNote, reviewedBy, { session });
        await CreditRecord.updateOne(
          { receipt: receipt._id, status: { $in: ["open", "partial"] } },
          { status: "voided", voidedAt: now },
          { session }
        );
      }
    });
  } catch (error) {
    if (session) await session.endSession();
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

// @desc    Reject a void request — receipt stays as-is
// @route   PATCH /api/void-requests/:id/reject
// @access  Protected — branchManager, admin
export const rejectVoidRequest = async (req, res, next) => {
  const { id } = req.params;
  const reviewedBy = req.user._id;

  try {
    logStart("voidRequest", "Rejecting void request", { voidRequestId: id, reviewedBy });

    const voidRequest = await VoidRequest.findByIdAndUpdate(
      id,
      { status: "rejected", reviewedBy, reviewedAt: new Date() },
      { new: true }
    ).populate("receipt", "branch");

    if (!voidRequest) {
      return res.status(404).json({ message: "Void request not found" });
    }

    const io = req.app.get("io");
    io.to(`branch:${voidRequest.receipt?.branch}`).emit("voidRequest:rejected", voidRequest);

    logSuccess("voidRequest", "Void request rejected", { voidRequestId: id });
    res.json({ message: "Void request rejected", voidRequest });
  } catch (error) {
    next(error);
  }
};
