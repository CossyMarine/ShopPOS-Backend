// controllers/receiptController.js
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import AdminSettings from "../models/AdminSettings.js";
import { stkPush, stkQuery } from "../utils/mpesa.js";
import {
  applyPaymentToReceipt,
  applyRewardRedemption,
  creditCashback,
  findCustomerByIdentifier,
} from "../utils/walletPayments.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";
import { badRequest, AppError } from "../utils/AppError.js";

// ---- split out into controllers/receipt/*, re-exported so routes/receiptRoutes.js
//      doesn't need to change its import path ----
export {
  getReceipts,
  getPaidReceipts,
  getPendingOnlineReceipts,
  getReceiptsTodaySummary,
  getReceiptsByCashier,
  getReceiptById,
  getReceiptHistory,
  getReceiptHistoryByCashier,
} from "./receipt/receiptQueries.js";

export { addItemsToReceipt, markReceiptPrinted , cancelUnpaidReceipt} from "./receipt/receiptManagement.js";

// ============================================================
// CASH PAYMENT
// ============================================================

// @desc    Pay a receipt with cash. Change is never allowed to be negative.
// @route   PATCH /api/receipts/:id/pay
// @access  Protected — cashier, branchManager, admin
export const payReceipt = async (req, res, next) => {
  const { id } = req.params;
  const { amountPaid } = req.body;

  try {
    logStart("receipt", "Processing cash payment", { receiptId: id, amountPaid });

    const receipt = await Receipt.findById(id);
    if (!receipt) {
      console.warn(`[receipt] ⚠️ Receipt not found: ${id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
    if (!["unpaid", "partial"].includes(receipt.status)) {
      console.warn(`[receipt] ⚠️ Receipt ${id} already ${receipt.status}`);
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    const received = parseFloat(amountPaid);
    const balanceDue = Number((receipt.totalDue - (receipt.amountPaid || 0)).toFixed(2));
    if (isNaN(received) || received < balanceDue) {
      console.warn(`[receipt] ⚠️ Amount received (${received}) < balance due (${balanceDue})`);
      return res.status(400).json({ message: "Amount received cannot be less than the balance due" });
    }

    const changeGiven = Number((received - balanceDue).toFixed(2));

    receipt.status = "paid";
    receipt.paymentMethod = "cash";
    receipt.cashAmount = (receipt.cashAmount || 0) + balanceDue;
    receipt.tillAmount = receipt.tillAmount || 0;
    receipt.amountPaid = receipt.totalDue;
    receipt.changeGiven = changeGiven;
    receipt.paidAt = new Date();
    receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
    receipt.payments.push({
      amount: balanceDue,
      method: "cash",
      paidBy: req.user?._id || null,
      paidAt: new Date(),
    });

    // Cashback is earned on the amount actually applied to the bill, not
    // the raw cash handed over (change given isn't real revenue).
    await creditCashback(receipt, balanceDue);

    await receipt.save();

    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("receipt:paid", receipt);

    logSuccess("receipt", "Cash payment processed", { receiptId: id, balanceDue, changeGiven });
    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// M-PESA (TILL) PAYMENT — STK PUSH
// ============================================================

// Shared: mark a receipt paid once Daraja confirms success (staff-initiated flow)
const finalizeMpesaSuccess = async ({ receipt, mpesaReceiptNumber, io }) => {
  const cashAmount = receipt.pendingCashAmount || 0;
  const tillAmount = receipt.pendingTillAmount || 0;

  receipt.status = "paid";
  receipt.paymentMethod = cashAmount > 0 ? "both" : "mpesa_till";
  receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
  receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
  receipt.amountPaid = receipt.totalDue;
  receipt.changeGiven = 0;
  receipt.paidAt = new Date();
  receipt.mpesaStatus = "success";
  receipt.mpesaReceiptNumber = mpesaReceiptNumber || receipt.mpesaReceiptNumber || null;
  receipt.mpesaResultDesc = "Payment received successfully";
  if (cashAmount > 0) {
    receipt.payments.push({ amount: cashAmount, method: "cash", paidAt: new Date() });
  }
  receipt.payments.push({
    amount: tillAmount,
    method: "mpesa_till",
    reference: receipt.mpesaReceiptNumber,
    paidAt: new Date(),
  });

  // Cashback on the full amount just settled (cash portion + till portion).
  await creditCashback(receipt, cashAmount + tillAmount);

  await receipt.save();

  await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

  io.to(`branch:${receipt.branch}`).emit("receipt:paid", receipt);
  io.to(`branch:${receipt.branch}`).emit("mpesa:result", {
    checkoutRequestId: receipt.mpesaCheckoutRequestId,
    status: "success",
    receipt,
  });

  logSuccess("receipt", "M-Pesa payment finalized (staff)", {
    receiptId: receipt._id, mpesaReceiptNumber: receipt.mpesaReceiptNumber, cashAmount, tillAmount,
  });
};

// Shared: apply a wallet-initiated STK push once Daraja confirms success —
// goes through applyPaymentToReceipt so partial payments and cashback work
const finalizeWalletMpesaSuccess = async ({ receipt, mpesaReceiptNumber, io }) => {
  const amount = receipt.pendingTillAmount || 0;
  const paidBy = receipt.pendingPaidBy;

  receipt.mpesaStatus = "success";
  receipt.mpesaReceiptNumber = mpesaReceiptNumber || receipt.mpesaReceiptNumber || null;
  receipt.mpesaResultDesc = "Payment received successfully";
  receipt.pendingTillAmount = 0;
  receipt.pendingCashAmount = 0;

  const updated = await applyPaymentToReceipt({
    receipt,
    amount,
    method: "mpesa_stk",
    reference: receipt.mpesaReceiptNumber,
    paidBy,
    io,
  });

  io.to(`branch:${updated.branch}`).emit("mpesa:result", {
    checkoutRequestId: updated.mpesaCheckoutRequestId,
    status: "success",
    receipt: updated,
  });

  logSuccess("receipt", "M-Pesa payment finalized (wallet)", {
    receiptId: updated._id, mpesaReceiptNumber: receipt.mpesaReceiptNumber, amount,
  });
};

const finalizeMpesaFailure = async ({ receipt, resultDesc, io }) => {
  receipt.mpesaStatus = "failed";
  receipt.mpesaResultDesc = resultDesc || "Payment was not completed";
  await receipt.save();

  io.to(`branch:${receipt.branch}`).emit("mpesa:result", {
    checkoutRequestId: receipt.mpesaCheckoutRequestId,
    status: "failed",
    message: receipt.mpesaResultDesc,
  });

  console.warn(`[receipt] ⚠️ M-Pesa payment failed for receipt ${receipt._id}: ${receipt.mpesaResultDesc}`);
};

// @desc    Trigger an STK push ("Prompt"). cashAmount = 0 for prompt-only, or
//          a partial amount for a split "both" payment (prompt covers the rest).
// @route   POST /api/receipts/:id/mpesa/initiate
// @access  Protected — cashier, branchManager, admin
export const initiateMpesaPayment = async (req, res, next) => {
  const { id } = req.params;
  let { phone, cashAmount } = req.body;

  try {
    logStart("receipt", "Initiating M-Pesa STK push", { receiptId: id, phone, cashAmount });

    const receipt = await Receipt.findById(id);
    if (!receipt) {
      console.warn(`[receipt] ⚠️ Receipt not found: ${id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
    if (!["unpaid", "partial"].includes(receipt.status)) {
      console.warn(`[receipt] ⚠️ Receipt ${id} already ${receipt.status}`);
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }
    if (!phone) {
      console.warn("[receipt] ⚠️ Missing M-Pesa phone number");
      return res.status(400).json({ message: "M-Pesa phone number is required" });
    }

    const balanceDue = Number((receipt.totalDue - (receipt.amountPaid || 0)).toFixed(2));
    cashAmount = parseFloat(cashAmount) || 0;
    if (cashAmount < 0) {
      return res.status(400).json({ message: "Cash amount cannot be negative" });
    }
    if (cashAmount >= balanceDue) {
      return res.status(400).json({
        message: "Cash amount covers the full balance — use Cash payment instead",
      });
    }

    const tillAmount = Number((balanceDue - cashAmount).toFixed(2));

    console.log(`[receipt] → Sending STK push: KES ${tillAmount} to ${phone} (ref: ${receipt.billId})`);

    const stkRes = await stkPush({
      phone,
      amount: tillAmount,
      accountRef: receipt.billId,
      description: `Bill ${receipt.billId}`,
    });

    if (String(stkRes.ResponseCode) !== "0") {
      console.warn(`[receipt] ⚠️ Daraja rejected STK push: ${stkRes.ResponseDescription}`);
      return res.status(400).json({
        message: stkRes.ResponseDescription || "Failed to initiate M-Pesa payment",
      });
    }

    receipt.mpesaSource = "staff";
    receipt.mpesaPhone = phone;
    receipt.mpesaCheckoutRequestId = stkRes.CheckoutRequestID;
    receipt.mpesaMerchantRequestId = stkRes.MerchantRequestID;
    receipt.mpesaStatus = "pending";
    receipt.mpesaResultDesc = null;
    receipt.mpesaReceiptNumber = null;
    receipt.pendingCashAmount = cashAmount;
    receipt.pendingTillAmount = tillAmount;
    await receipt.save();

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("receipt:mpesaPending", receipt);

    logSuccess("receipt", "STK push sent", { receiptId: id, checkoutRequestId: stkRes.CheckoutRequestID, tillAmount, cashAmount });

    res.json({
      message: "STK push sent. Ask the customer to enter their M-Pesa PIN.",
      checkoutRequestId: stkRes.CheckoutRequestID,
      tillAmount,
      cashAmount,
    });
  } catch (error) {
    // Preserve the M-Pesa-specific rejection reason, same reasoning as
    // walletController.payWithStk.
    next(new AppError(
      error.response?.data?.errorMessage || error.message || "Failed to initiate M-Pesa payment",
      500
    ));
  }
};

// @desc    Daraja calls this once the customer responds to the STK prompt
// @route   POST /api/receipts/mpesa/callback
// @access  Public (Safaricom webhook)
export const mpesaCallback = async (req, res) => {
  // NOTE: intentionally NOT converted to next(error) — this is a Safaricom
  // webhook and must always return 200, regardless of outcome. Returning a
  // non-200 (which the centralized errorHandler would do) makes Daraja
  // retry the callback, risking a double-apply of the payment. Keep this
  // route's own try/catch and always respond 200.
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      console.warn("[receipt] ⚠️ M-Pesa callback received with no stkCallback body — ignored");
      return res.status(200).json({ message: "Ignored" });
    }

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;
    logStart("receipt", "M-Pesa callback received", { CheckoutRequestID, ResultCode, ResultDesc });

    const receipt = await Receipt.findOne({ mpesaCheckoutRequestId: CheckoutRequestID });
    if (!receipt || !["unpaid", "partial"].includes(receipt.status)) {
      console.warn(`[receipt] ⚠️ Callback for ${CheckoutRequestID} — receipt not found or already settled`);
      return res.status(200).json({ message: "Receipt not found or already settled" });
    }

    const io = req.app.get("io");

    if (Number(ResultCode) === 0) {
      const items = CallbackMetadata?.Item || [];
      const receiptNumberItem = items.find((i) => i.Name === "MpesaReceiptNumber");
      const mpesaReceiptNumber = receiptNumberItem?.Value || null;

      if (receipt.mpesaSource === "wallet") {
        await finalizeWalletMpesaSuccess({ receipt, mpesaReceiptNumber, io });
      } else {
        await finalizeMpesaSuccess({ receipt, mpesaReceiptNumber, io });
      }
    } else {
      await finalizeMpesaFailure({ receipt, resultDesc: ResultDesc, io });
    }

    logSuccess("receipt", "M-Pesa callback processed", { CheckoutRequestID, ResultCode });
    res.status(200).json({ message: "Callback processed" });
  } catch (error) {
    logError("receipt", "M-Pesa callback error", error);
    // Always 200 back to Daraja — logging the failure is what matters here,
    // returning a non-200 would just cause Safaricom to retry the callback.
    res.status(200).json({ message: "Callback error logged" });
  }
};

// @desc    Poll payment status. Also actively queries Daraja, so payment
//          still completes even if the callback URL can't be reached.
// @route   GET /api/receipts/:id/mpesa/status
// @access  Protected — cashier, branchManager, admin
export const getMpesaStatus = async (req, res, next) => {
  try {
    logStart("receipt", "Checking M-Pesa status", { receiptId: req.params.id });

    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) {
      console.warn(`[receipt] ⚠️ Receipt not found: ${req.params.id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }

    if (receipt.status === "paid") {
      logSuccess("receipt", "M-Pesa status: already paid", { receiptId: req.params.id });
      return res.json({ status: "success", receipt });
    }
    if (receipt.mpesaStatus !== "pending" || !receipt.mpesaCheckoutRequestId) {
      logSuccess("receipt", "M-Pesa status: not pending", { receiptId: req.params.id, mpesaStatus: receipt.mpesaStatus || "idle" });
      return res.json({ status: receipt.mpesaStatus || "idle", receipt });
    }

    const io = req.app.get("io");

    try {
      const queryRes = await stkQuery(receipt.mpesaCheckoutRequestId);
      const resultCode = Number(queryRes.ResultCode);

      if (resultCode === 0) {
        if (receipt.mpesaSource === "wallet") {
          await finalizeWalletMpesaSuccess({ receipt, mpesaReceiptNumber: null, io });
        } else {
          await finalizeMpesaSuccess({ receipt, mpesaReceiptNumber: null, io });
        }
        return res.json({ status: "success", receipt });
      }
      if (!isNaN(resultCode)) {
        await finalizeMpesaFailure({ receipt, resultDesc: queryRes.ResultDesc, io });
        return res.json({ status: "failed", message: queryRes.ResultDesc, receipt });
      }
    } catch (queryErr) {
      // Daraja returns an error while the push is still awaiting PIN entry —
      // this is expected mid-flight, not a real failure, so it's a warn not logError.
      console.warn(`[receipt] ⚠️ M-Pesa status query still pending:`, queryErr.response?.data || queryErr.message);
    }

    logSuccess("receipt", "M-Pesa status: still pending", { receiptId: req.params.id });
    res.json({ status: "pending", receipt });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel a pending STK push so the cashier can retry or switch method
// @route   POST /api/receipts/:id/mpesa/cancel
// @access  Protected — cashier, branchManager, admin
export const cancelMpesaPayment = async (req, res, next) => {
  try {
    logStart("receipt", "Cancelling M-Pesa payment", { receiptId: req.params.id });

    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) {
      console.warn(`[receipt] ⚠️ Receipt not found: ${req.params.id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }

    receipt.mpesaStatus = "idle";
    receipt.mpesaCheckoutRequestId = null;
    receipt.mpesaMerchantRequestId = null;
    receipt.mpesaResultDesc = null;
    receipt.pendingCashAmount = 0;
    receipt.pendingTillAmount = 0;
    await receipt.save();

    logSuccess("receipt", "M-Pesa payment cancelled", { receiptId: req.params.id });
    res.json({ message: "Cancelled", receipt });
  } catch (error) {
    next(error);
  }
};

// @desc    Split payment: part cash in hand + part already paid manually to
//          the till/paybill by the customer. Till portion auto-covers
//          whatever's left after the cash amount — same "auto-covers the
//          rest" pattern as the Cash+Prompt split. Staff-only, so no M-Pesa
//          code / customer name is collected (that's only required on the
//          customer-facing wallet self-pay flow).
// @route   PATCH /api/receipts/:id/pay/cash-till
// @access  Protected — cashier, branchManager, admin
export const payCashAndTill = async (req, res, next) => {
  const { id } = req.params;
  let { cashAmount } = req.body;

  try {
    logStart("receipt", "Processing cash+till payment", { receiptId: id, cashAmount });

    const receipt = await Receipt.findById(id);
    if (!receipt) {
      console.warn(`[receipt] ⚠️ Receipt not found: ${id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
    if (!["unpaid", "partial"].includes(receipt.status)) {
      console.warn(`[receipt] ⚠️ Receipt ${id} already ${receipt.status}`);
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    const balanceDue = Number((receipt.totalDue - (receipt.amountPaid || 0)).toFixed(2));
    cashAmount = parseFloat(cashAmount);

    if (isNaN(cashAmount) || cashAmount <= 0) {
      return res.status(400).json({ message: "Cash amount must be more than 0" });
    }
    if (cashAmount >= balanceDue) {
      return res.status(400).json({
        message: "Cash amount covers the full balance — use Cash payment instead",
      });
    }

    const tillAmount = Number((balanceDue - cashAmount).toFixed(2));

    receipt.status = "paid";
    receipt.paymentMethod = "both";
    receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
    receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
    receipt.amountPaid = receipt.totalDue;
    receipt.changeGiven = 0;
    receipt.paidAt = new Date();
    receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
    receipt.payments.push(
      { amount: cashAmount, method: "cash", paidBy: req.user?._id || null, paidAt: new Date() },
      { amount: tillAmount, method: "manual_till", paidBy: req.user?._id || null, paidAt: new Date() }
    );

    // Cashback on the full balance just settled (cash + till combined).
    await creditCashback(receipt, cashAmount + tillAmount);

    await receipt.save();

    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

    const io = req.app.get("io");
    io.to(`branch:${receipt.branch}`).emit("receipt:paid", receipt);

    logSuccess("receipt", "Cash+till payment processed", { receiptId: id, cashAmount, tillAmount });
    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    next(error);
  }
};

// ============================================================
// COMBO PAYMENT — cash + till + reward in one action
// ============================================================

// @desc    Apply any mix of cash, manual-till, and a customer's reward
//          points to a bill in a single call — this is the "always ask if
//          that user should be rewarded" flow at checkout. Any leftover
//          balance (e.g. the rest is going on M-Pesa prompt) is left due —
//          call POST /:id/mpesa/initiate next for that remainder.
// @route   PATCH /api/receipts/:id/pay/combo
// @access  Protected — cashier, branchManager, admin (open shift required)
export const payCombo = async (req, res, next) => {
  const { id } = req.params;
  let { cashAmount, tillAmount, rewardIdentifier, rewardAmount } = req.body;

  cashAmount = parseFloat(cashAmount) || 0;
  tillAmount = parseFloat(tillAmount) || 0;
  rewardAmount = parseFloat(rewardAmount) || 0;

  if (cashAmount < 0 || tillAmount < 0 || rewardAmount < 0) {
    return res.status(400).json({ message: "Amounts cannot be negative" });
  }
  if (cashAmount === 0 && tillAmount === 0 && rewardAmount === 0) {
    return res.status(400).json({ message: "Enter at least one amount" });
  }

  try {
    logStart("receipt", "Processing combo payment", { receiptId: id, cashAmount, tillAmount, rewardAmount });

    const receipt = await Receipt.findById(id);
    if (!receipt) {
      console.warn(`[receipt] ⚠️ Receipt not found: ${id}`);
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (!["unpaid", "partial"].includes(receipt.status)) {
      console.warn(`[receipt] ⚠️ Receipt ${id} already ${receipt.status}`);
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;

    const balanceBefore = Number((receipt.totalDue - (receipt.amountPaid || 0)).toFixed(2));
    if (cashAmount + tillAmount + rewardAmount - balanceBefore > 0.01) {
      console.warn(`[receipt] ⚠️ Combo amount (${cashAmount + tillAmount + rewardAmount}) exceeds balance (${balanceBefore})`);
      return res.status(400).json({ message: "Combined amount cannot exceed the balance due" });
    }

    const io = req.app.get("io");

    // ---- Reward leg first — needs the customer's own points balance ----
    if (rewardAmount > 0) {
      if (!rewardIdentifier || !rewardIdentifier.trim()) {
        return res.status(400).json({ message: "Customer email or phone is required to redeem reward points" });
      }
      const customer = await findCustomerByIdentifier(rewardIdentifier);
      if (!customer) {
        console.warn(`[receipt] ⚠️ No customer found for identifier "${rewardIdentifier}"`);
        return res.status(404).json({ message: "No registered customer found with that email or phone" });
      }
      const settings = await AdminSettings.getSettings();
      const pointValue = settings.reward.pointValueKes || 1;
      const pointsToRedeem = Math.ceil(rewardAmount / pointValue);
      if (pointsToRedeem > (customer.walletPoints || 0)) {
        console.warn(`[receipt] ⚠️ ${customer.fullName} has insufficient points: needs ${pointsToRedeem}, has ${customer.walletPoints}`);
        return res.status(400).json({
          message: `${customer.fullName} only has ${customer.walletPoints} points available`,
        });
      }
      await applyRewardRedemption({ receipt, user: customer, pointsToRedeem, io });
      // applyRewardRedemption already saved the receipt — keep working off
      // the same in-memory doc, it's up to date.
    }

    // ---- Cash / till legs ----
    if (cashAmount > 0) {
      receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
      receipt.payments.push({ amount: cashAmount, method: "cash", paidBy: req.user?._id || null, paidAt: new Date() });
      await creditCashback(receipt, cashAmount);
    }
    if (tillAmount > 0) {
      receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
      receipt.payments.push({ amount: tillAmount, method: "manual_till", paidBy: req.user?._id || null, paidAt: new Date() });
      await creditCashback(receipt, tillAmount);
    }

    if (cashAmount > 0 || tillAmount > 0) {
      const totalPaid = receipt.payments.reduce((sum, p) => sum + p.amount, 0);
      receipt.amountPaid = Number(totalPaid.toFixed(2));
      receipt.paymentMethod = receipt.payments.length > 1 ? "both" : cashAmount > 0 ? "cash" : "manual_till";
      receipt.status = totalPaid >= receipt.totalDue ? "paid" : "partial";
      if (receipt.status === "paid") receipt.paidAt = new Date();
      receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
      await receipt.save();
    }

    if (receipt.status === "paid") {
      await Order.findByIdAndUpdate(receipt.order, { status: "completed" });
    }

    if (io) {
      io.to(`branch:${receipt.branch}`).emit("receipt:updated", receipt);
      if (receipt.status === "paid") io.to(`branch:${receipt.branch}`).emit("receipt:paid", receipt);
    }

    const balanceRemaining = Number((receipt.totalDue - (receipt.amountPaid || 0)).toFixed(2));

    logSuccess("receipt", "Combo payment processed", {
      receiptId: id, status: receipt.status, cashAmount, tillAmount, rewardAmount, balanceRemaining,
    });

    res.json({
      message: receipt.status === "paid" ? "Payment complete" : `Applied — KES ${balanceRemaining.toLocaleString()} still due`,
      receipt,
      balanceRemaining,
    });
  } catch (error) {
    // applyRewardRedemption throws plain Errors for validation-style
    // failures — this route always treated those as 400s, not 500s.
    next(badRequest(error.message || "Failed to process payment"));
  }
};
