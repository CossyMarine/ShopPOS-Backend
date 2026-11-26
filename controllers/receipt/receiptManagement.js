// controllers/receipt/receiptManagement.js
import mongoose from "mongoose";
import Receipt from "../../models/Receipt.js";
import Order from "../../models/Order.js";
import Product from "../../models/Product.js";
import { deductStockFIFO, restockItems } from "../../utils/productStock.js";
import { logStart, logSuccess } from "../../utils/requestLogger.js";

// @desc    Add items to an unpaid bill — e.g. a held/parked sale the cashier
//          is resuming, or a correction before the customer pays. Deducts
//          stock FIFO for the newly added items only (items already on the
//          bill were already deducted when the sale was first created).
// @route   PATCH /api/receipts/:id/items
// @access  Protected — cashier, branchManager, admin
export const addItemsToReceipt = async (req, res, next) => {
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "At least one item is required" });
  }

  try {
    logStart("receiptMgmt", "Adding items to receipt", { receiptId: id, itemCount: items.length });

    const receipt = await Receipt.findById(id);
    if (!receipt) {
      console.warn(`[receiptMgmt] ⚠️ Receipt not found: ${id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (receipt.status !== "unpaid") {
      console.warn(`[receiptMgmt] ⚠️ Receipt ${id} is ${receipt.status}, not unpaid — blocked`);
      return res.status(400).json({ message: "Only unpaid bills can be added to" });
    }

    const now = new Date();

    // Always appended as their own line items rather than merged into an
    // existing line — keeps a clean, distinct audit trail of what was
    // added and when, even if an earlier line of the same product exists.
    const addedItems = items.map((incoming) => ({
      productId: incoming.productId || incoming._id || null,
      productName: incoming.productName,
      imageUrl: incoming.imageUrl || null,
      quantity: incoming.quantity,
      unitPrice: incoming.unitPrice,
      lineTotal: incoming.quantity * incoming.unitPrice,
      costPriceAtSale: null, // filled in below once we know the real cost
      addedAt: now,
    }));

    // Deduct stock FIFO for the newly added items only, capturing real cost
    for (const line of addedItems) {
      if (!line.productId) continue; // manually-entered fallback line
      const product = await Product.findById(line.productId);
      if (!product) {
        console.warn(`[receiptMgmt] ⚠️ Product not found: ${line.productName} (${line.productId})`);
        return res.status(404).json({ message: `Product not found: ${line.productName}` });
      }
      const { avgCostPerUnit } = await deductStockFIFO(product, line.quantity);
      line.costPriceAtSale = avgCostPerUnit;
    }

    const merged = [...receipt.items, ...addedItems];
    const subtotal = merged.reduce((sum, i) => sum + i.lineTotal, 0);

    receipt.items = merged;
    receipt.subtotal = subtotal;
    await receipt.save();

    const order = await Order.findByIdAndUpdate(receipt.order, { items: merged, subtotal }, { new: true });

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);
    if (order) {
      io.to(`branch:${receipt.branch}`).emit("order:updated", order);
      io.to(`branch:${receipt.branch}`).emit("order:itemsAdded", { order, receipt, addedItems });
    }

    logSuccess("receiptMgmt", "Items added to receipt", { receiptId: id, addedCount: addedItems.length, newSubtotal: subtotal });
    res.json(receipt);
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel a bill that was started but never paid — e.g. the cashier
//          closed the payment popup, or the browser tab/window was closed,
//          before any money changed hands. Restocks every line and marks
//          both the receipt and its order as voided/cancelled. Only allowed
//          while status is "unpaid" and nothing has been paid yet — once
//          even a partial payment lands, this must go through the
//          manager-approved void-request flow instead.
//
//          Safe against double taps / two tabs: the receipt is CLAIMED with a
//          single atomic findOneAndUpdate (unpaid -> voided) inside the same
//          transaction as the restock. Only the request that wins the claim
//          restocks; the loser finds nothing to claim and restocks nothing.
//          If the transaction fails, the claim rolls back with it.
// @route   POST /api/receipts/:id/cancel
// @access  Protected — cashier, branchManager, admin
export const cancelUnpaidReceipt = async (req, res, next) => {
  const { id } = req.params;
  let session;
  let receipt = null;

  try {
    logStart("receiptMgmt", "Cancelling unpaid receipt", { receiptId: id });

    session = await mongoose.startSession();

    await session.withTransaction(async () => {
      receipt = null; // withTransaction may retry — always start clean

      receipt = await Receipt.findOneAndUpdate(
        {
          _id: id,
          status: "unpaid",
          // nothing paid yet
          $or: [{ amountPaid: { $exists: false } }, { amountPaid: null }, { amountPaid: { $lte: 0 } }],
          // an STK push in flight could still turn into real money
          mpesaStatus: { $ne: "pending" },
        },
        {
          $set: {
            status: "voided",
            voidedAt: new Date(),
            voidReason: "Checkout abandoned before payment",
          },
        },
        { new: true, session }
      );

      if (!receipt) return; // lost the claim (or not eligible) — nothing written

      await restockItems(
        receipt.items,
        `Cancelled before payment — bill ${receipt.billId}`,
        req.user?._id || null,
        { session }
      );

      await Order.findByIdAndUpdate(
        receipt.order,
        { status: "cancelled", cancelledAt: new Date() },
        { session }
      );
    });

    if (!receipt) {
      // Work out why the claim failed, so the caller gets a useful answer.
      const existing = await Receipt.findById(id).select("status amountPaid mpesaStatus voidReason");
      if (!existing) {
        console.warn(`[receiptMgmt] ⚠️ Receipt not found: ${id}`);
        return res.status(404).json({ message: "Receipt not found" });
      }
      if (existing.status === "voided" && existing.voidReason === "Checkout abandoned before payment") {
        // Double tap / second tab — the first request already did the work.
        return res.json({ message: "Checkout already cancelled", alreadyCancelled: true });
      }
      if (existing.mpesaStatus === "pending") {
        return res.status(409).json({
          message: "An M-Pesa payment is still pending on this bill — cancel the M-Pesa request first",
        });
      }
      console.warn(`[receiptMgmt] ⚠️ Receipt ${id} not eligible — status=${existing.status}, amountPaid=${existing.amountPaid || 0}`);
      return res.status(400).json({
        message: "Only a fully-unpaid bill can be cancelled this way — use a void request instead",
      });
    }

    // Emit only after the transaction has committed.
    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("receipt:voided", receipt);
    io.to(`branch:${receipt.branch}`).emit("sale:cancelled", { receiptId: receipt._id, orderId: receipt.order });

    logSuccess("receiptMgmt", "Unpaid receipt cancelled and restocked", { receiptId: id, itemCount: receipt.items.length });
    res.json({ message: "Checkout cancelled and stock restored" });
  } catch (error) {
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// @desc    Record that a receipt was (re)printed
// @route   PATCH /api/receipts/:id/print
// @access  Protected
export const markReceiptPrinted = async (req, res, next) => {
  try {
    logStart("receiptMgmt", "Marking receipt printed", { receiptId: req.params.id });

    const receipt = await Receipt.findByIdAndUpdate(
      req.params.id,
      { $inc: { printCount: 1 }, $set: { printedAt: new Date() } },
      { new: true }
    );
    if (!receipt) {
      console.warn(`[receiptMgmt] ⚠️ Receipt not found: ${req.params.id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }

    logSuccess("receiptMgmt", "Receipt marked printed", { receiptId: req.params.id, printCount: receipt.printCount });
    res.json(receipt);
  } catch (error) {
    next(error);
  }
};
