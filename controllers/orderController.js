// controllers/orderController.js
import { finalizeSale } from "../utils/finalizeSale.js";

// @desc    Finalize a checkout: creates the order, deducts stock FIFO, generates receipt
// @route   POST /api/orders
// @access  Protected — cashier, branchManager, admin
export const createOrder = async (req, res, next) => {
  const { items, branch, customer, customerName, clientSaleId } = req.body;

  try {
    const { order, receipt, isDuplicate } = await finalizeSale({
      items,
      branch,
      cashierId: req.user._id,
      customer,
      customerName,
      clientSaleId,       // optional even for live sales — a double-tapped checkout button on a slow connection is the same problem as an offline retry
      shiftId: req.shift?._id, // requireOpenShift middleware already resolved this
      io: req.app.get("io"),
    });

    res.status(isDuplicate ? 200 : 201).json({ order, receipt });
  } catch (error) {
    next(error);
  }
};
