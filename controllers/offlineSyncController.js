// controllers/offlineSyncController.js
import { finalizeSale } from "../utils/finalizeSale.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Replays a backlog of sales that were rung up while a device had
//          no connection. Each sale is processed independently — one bad
//          line in the batch doesn't take the rest down with it — and the
//          response reports a result per sale so the client knows exactly
//          which queue entries are safe to clear and which need to stay
//          queued (or be surfaced to a manager) for another attempt.
//
//          Every sale MUST carry its own clientSaleId (generated on-device
//          the instant checkout was tapped, before the request was ever
//          attempted) — this is what makes it safe to call this endpoint
//          more than once with the same backlog if a sync gets interrupted
//          partway through.
// @route   POST /api/orders/sync-batch
// @body    { sales: [{ clientSaleId, items, branch, customer, customerName, soldAt, shiftId }, ...] }
// @access  Protected — cashier, branchManager, admin
//          (deliberately NOT gated by requireOpenShift — these sales already
//          happened under a shift that was open on the device at the time;
//          by the time they sync, that shift may have legitimately closed)
export const syncOfflineOrders = async (req, res, next) => {
  try {
    const { sales } = req.body;
    logStart("offlineSync", "Replaying offline sale batch", { count: sales?.length || 0 });

    if (!Array.isArray(sales) || sales.length === 0) {
      return res.status(400).json({ message: "sales must be a non-empty array" });
    }

    const io = req.app.get("io");
    const results = [];

    // Sequential on purpose — these hit the same products/stock as each
    // other and as anything happening live right now. Running them in
    // parallel would let two lines in the same batch race on the same
    // product's stock instead of deducting in a predictable order.
    for (const sale of sales) {
      const { clientSaleId, items, branch, customer, customerName, soldAt, shiftId } = sale;

      if (!clientSaleId) {
        results.push({ clientSaleId: null, status: "failed", error: "Missing clientSaleId — cannot sync a sale without an idempotency key" });
        continue;
      }

      try {
        const { order, receipt, isDuplicate, stockDiscrepancy } = await finalizeSale({
          items,
          branch,
          cashierId: req.user._id,
          customer,
          customerName,
          soldAt,
          shiftId,
          clientSaleId,
          allowNegativeStock: true, // this sale already happened — never reject it for stock that's since run out
          syncedFromOffline: true,
          io,
        });

        results.push({
          clientSaleId,
          status: isDuplicate ? "duplicate" : "synced",
          orderId: order._id,
          receiptId: receipt?._id || null,
          stockDiscrepancy,
        });
      } catch (error) {
        results.push({ clientSaleId, status: "failed", error: error.message });
      }
    }

    const summary = {
      synced: results.filter((r) => r.status === "synced").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
      failed: results.filter((r) => r.status === "failed").length,
      discrepancies: results.filter((r) => r.stockDiscrepancy).length,
    };

    logSuccess("offlineSync", "Batch replay complete", summary);
    res.json({ results, summary });
  } catch (error) {
    next(error);
  }
};
