// controllers/voidRequestController.js
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import VoidRequest from "../models/VoidRequest.js";
import Product from "../models/Product.js";

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
export const getVoidRequests = async (req, res) => {
  try {
    const voidRequests = await VoidRequest.find({ status: "pending" })
      .populate({
        path: "receipt",
        ...(req.query.branch ? { match: { branch: req.query.branch } } : {}),
      })
      .populate("requestedBy", "fullName")
      .sort({ createdAt: -1 });

    const filtered = voidRequests.filter((v) => v.receipt);

    res.json(filtered);
  } catch (error) {
    console.error("Error fetching void requests:", error.message);
    res.status(500).json({ message: "Failed to fetch void requests", error: error.message });
  }
};

// @desc    Request a receipt — or specific line items on it — be voided.
//          Body: { receiptId, reason, items? }
//          `items` is an optional array of indices into receipt.items.
//          Omit it (or include every index) to request voiding the whole bill.
// @route   POST /api/void-requests
// @access  Protected — cashier, branchManager, admin
export const createVoidRequest = async (req, res) => {
  try {
    const { receiptId, reason, items } = req.body;
    const requestedBy = req.user._id;

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

    res.status(201).json({ message: "Void request submitted", voidRequest });
  } catch (error) {
    console.error("Error creating void request:", error.message);
    res.status(500).json({ message: "Failed to create void request", error: error.message });
  }
};

// @desc    Approve a void request — voids the whole receipt, or (for a
//          partial request) removes only the requested line items,
//          restocks them, and recalculates the bill's subtotal/status.
// @route   PATCH /api/void-requests/:id/approve
// @access  Protected — branchManager, admin
export const approveVoidRequest = async (req, res) => {
  const { id } = req.params;
  const reviewedBy = req.user._id;

  try {
    const voidRequest = await VoidRequest.findByIdAndUpdate(
      id,
      { status: "approved", reviewedBy, reviewedAt: new Date() },
      { new: true }
    );
    if (!voidRequest) {
      return res.status(404).json({ message: "Void request not found" });
    }

    const receipt = await Receipt.findById(voidRequest.receipt);
    if (!receipt) {
      return res.status(404).json({ message: "Receipt no longer exists" });
    }

    const io = req.app.get("io");

    if (voidRequest.voidType === "partial" && voidRequest.voidItems.length < receipt.items.length) {
      const voidedIndices = new Set(voidRequest.voidItems.map((v) => v.index));

      await restockItems(voidRequest.voidItems, receipt.billId, reviewedBy);

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

      await receipt.save();
      await Order.findByIdAndUpdate(receipt.order, { items: remainingItems, subtotal: newSubtotal });

      io.to(`branch:${receipt.branch}`).emit("voidRequest:approved", voidRequest);
      io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);
    } else {
      receipt.status = "voided";
      await receipt.save();
      await restockItems(receipt.items, receipt.billId, reviewedBy);

      io.to(`branch:${receipt.branch}`).emit("voidRequest:approved", voidRequest);
      io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);
    }

    res.json({ message: "Void request approved", voidRequest, receipt });
  } catch (error) {
    console.error("Error approving void request:", error.message);
    res.status(500).json({ message: "Failed to approve void request", error: error.message });
  }
};

// @desc    Reject a void request — receipt stays as-is
// @route   PATCH /api/void-requests/:id/reject
// @access  Protected — branchManager, admin
export const rejectVoidRequest = async (req, res) => {
  const { id } = req.params;
  const reviewedBy = req.user._id;

  try {
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

    res.json({ message: "Void request rejected", voidRequest });
  } catch (error) {
    console.error("Error rejecting void request:", error.message);
    res.status(500).json({ message: "Failed to reject void request", error: error.message });
  }
};
