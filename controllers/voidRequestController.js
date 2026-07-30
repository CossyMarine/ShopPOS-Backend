// controllers/voidRequestController.js
import Receipt from "../models/Receipt.js";
import VoidRequest from "../models/VoidRequest.js";
import Product from "../models/Product.js";

// Reverses a FIFO deduction — adds the quantity back as a new batch at the
// original unit cost where known, so voiding a sale doesn't silently lose
// stock. Runs per line item on approval.
const restockVoidedReceipt = async (receipt, restockedBy) => {
  for (const line of receipt.items) {
    if (!line.productId) continue; // manually-entered fallback line, nothing to restock
    const product = await Product.findById(line.productId);
    if (!product) continue;
    product.batches.push({
      quantity: line.quantity,
      costPerUnit: line.unitPrice, // best available cost reference for a voided sale
      expiryDate: null,
      receivedBy: restockedBy,
      supplierNote: `Restocked from voided bill ${receipt.billId}`,
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

    // Drop entries whose receipt got filtered out by the branch match above
    const filtered = voidRequests.filter((v) => v.receipt);

    res.json(filtered);
  } catch (error) {
    console.error("Error fetching void requests:", error.message);
    res.status(500).json({ message: "Failed to fetch void requests", error: error.message });
  }
};

// @desc    Request a receipt be voided (manager override, per your cashier mockup)
// @route   POST /api/void-requests
// @access  Protected — cashier, branchManager, admin
export const createVoidRequest = async (req, res) => {
  try {
    const { receiptId, reason } = req.body;
    const requestedBy = req.user._id;

    const receipt = await Receipt.findById(receiptId);
    if (!receipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (receipt.status === "voided") {
      return res.status(400).json({ message: "Receipt is already voided" });
    }

    const voidRequest = await VoidRequest.create({
      receipt: receiptId,
      requestedBy,
      reason,
    });

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("voidRequest:created", voidRequest);

    res.status(201).json({ message: "Void request submitted", voidRequest });
  } catch (error) {
    console.error("Error creating void request:", error.message);
    res.status(500).json({ message: "Failed to create void request", error: error.message });
  }
};

// @desc    Approve a void request — voids the underlying receipt and
//          restocks every line item back into inventory
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

    const receipt = await Receipt.findByIdAndUpdate(voidRequest.receipt, { status: "voided" }, { new: true });
    if (receipt) {
      await restockVoidedReceipt(receipt, reviewedBy);
    }

    const io = req.app.get("io");
    io.to(`branch:${receipt?.branch}`).emit("voidRequest:approved", voidRequest);
    if (receipt) io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);

    res.json({ message: "Void request approved and stock restored", voidRequest });
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
