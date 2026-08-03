// controllers/receipt/receiptQueries.js
import Receipt from "../../models/Receipt.js";
import { getKenyanDayBounds } from "../../utils/dateHelpers.js";

// @desc    Get all unpaid or partially-paid receipts for a branch
//          (Super Admin can omit ?branch= to see every branch)
// @route   GET /api/receipts?branch=
// @access  Protected — cashier, branchManager, admin (auto-scoped via sameBranch)
export const getReceipts = async (req, res) => {
  try {
    const filter = { status: { $in: ["unpaid", "partial"] } };
    if (req.query.branch) filter.branch = req.query.branch;

    const receipts = await Receipt.find(filter).sort({ createdAt: -1 });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch receipts" });
  }
};

// @desc    Get paid receipts (most recent first) — branchManager/admin view
// @route   GET /api/receipts/paid?branch=
// @access  Protected — branchManager, admin
export const getPaidReceipts = async (req, res) => {
  try {
    const filter = { status: "paid" };
    if (req.query.branch) filter.branch = req.query.branch;

    const receipts = await Receipt.find(filter).sort({ paidAt: -1 }).limit(200);
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching paid receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch paid receipts" });
  }
};

// @desc    Bills placed via the Customer Portal, unpaid — the "Online Bills"
//          tab. No claiming step needed: any cashier at the branch can act
//          on it, unlike the restaurant's per-waiter assignment flow.
// @route   GET /api/receipts/online-pending?branch=
// @access  Protected — cashier, branchManager, admin
export const getPendingOnlineReceipts = async (req, res) => {
  try {
    const filter = { source: "online", status: { $in: ["unpaid", "partial"] } };
    if (req.query.branch) filter.branch = req.query.branch;

    const receipts = await Receipt.find(filter).sort({ createdAt: 1 });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching pending online receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch pending online receipts" });
  }
};

// @desc    Today's paid vs unpaid totals — powers the "All" tab summary bar
// @route   GET /api/receipts/summary/today?branch=
// @access  Protected — cashier, branchManager, admin
export const getReceiptsTodaySummary = async (req, res) => {
  try {
    const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();
    const branchMatch = req.query.branch
      ? { branch: new mongoose.Types.ObjectId(req.query.branch) }
      : {};

    const [paidAgg, unpaidAgg] = await Promise.all([
      Receipt.aggregate([
        { $match: { status: "paid", paidAt: { $gte: startOfDay, $lte: endOfDay }, ...branchMatch } },
        { $group: { _id: null, total: { $sum: "$subtotal" }, count: { $sum: 1 } } },
      ]),
      Receipt.aggregate([
        { $match: { status: { $in: ["unpaid", "partial"] }, createdAt: { $gte: startOfDay, $lte: endOfDay }, ...branchMatch } },
        { $group: { _id: null, total: { $sum: "$subtotal" }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      paidToday: paidAgg[0]?.total || 0,
      paidTodayCount: paidAgg[0]?.count || 0,
      unpaidToday: unpaidAgg[0]?.total || 0,
      unpaidTodayCount: unpaidAgg[0]?.count || 0,
    });
  } catch (error) {
    console.error("Error fetching today's summary:", error.message);
    res.status(500).json({ message: "Failed to fetch summary" });
  }
};

// @desc    Get unpaid/partial receipts for a specific cashier
// @route   GET /api/receipts/cashier/:name
// @access  Protected
export const getReceiptsByCashier = async (req, res) => {
  try {
    const { name } = req.params;
    const receipts = await Receipt.find({ cashierName: name, status: { $in: ["unpaid", "partial"] } }).sort({
      createdAt: -1,
    });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching receipts by cashier:", error.message);
    res.status(500).json({ message: "Failed to fetch receipts" });
  }
};

// @desc    Get a single receipt (used for print / add-items refresh)
// @route   GET /api/receipts/:id
// @access  Protected
export const getReceiptById = async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id)
      .populate("payments.paidBy", "fullName email phone isAdmin role")
      .populate("pendingManualPayments.paidBy", "fullName email phone isAdmin role")
      .populate("customer", "fullName email phone role")
      .populate("branch", "name");
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json(receipt);
  } catch (error) {
    console.error("Error fetching receipt:", error.message);
    res.status(500).json({ message: "Failed to fetch receipt" });
  }
};

// @desc    Paginated bill history — every status, newest first. Branch-
//          scoped for staff, or filterable by ?branch= for Super Admin's
//          cross-branch view.
// @route   GET /api/receipts/history?page=1&limit=10&q=search&from=ISO&to=ISO&branch=
// @access  Protected
export const getReceiptHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const q = (req.query.q || "").trim();
    const { from, to, branch } = req.query;

    const filter = {};
    if (branch) filter.branch = branch;
    if (q) {
      filter.$or = [
        { billId: { $regex: q, $options: "i" } },
        { cashierName: { $regex: q, $options: "i" } },
      ];
    }
    if (from || to) {
      // Both bounds are anchored to the Kenyan calendar day the picker value
      // falls on, and "to" is pushed to the end of that day so it's inclusive.
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = getKenyanDayBounds(from).start;
      if (to) filter.createdAt.$lte = getKenyanDayBounds(to).end;
    }

    const total = await Receipt.countDocuments(filter);
    const receipts = await Receipt.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      receipts,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Error fetching bill history:", error.message);
    res.status(500).json({ message: "Failed to fetch bill history" });
  }
};

// @desc    Paginated bill history for one cashier, every status, newest first
// @route   GET /api/receipts/cashier/:name/history?page=1&limit=4&q=search&from=ISO&to=ISO
// @access  Protected
export const getReceiptHistoryByCashier = async (req, res) => {
  try {
    const { name } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 4);
    const q = (req.query.q || "").trim();
    const { from, to } = req.query;

    const filter = { cashierName: name };
    if (q) {
      filter.$or = [{ billId: { $regex: q, $options: "i" } }];
    }
    if (from || to) {
      // Same Kenya-day anchoring as getReceiptHistory above.
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = getKenyanDayBounds(from).start;
      if (to) filter.createdAt.$lte = getKenyanDayBounds(to).end;
    }

    const total = await Receipt.countDocuments(filter);
    const receipts = await Receipt.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      receipts,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Error fetching bill history:", error.message);
    res.status(500).json({ message: "Failed to fetch bill history" });
  }
};
