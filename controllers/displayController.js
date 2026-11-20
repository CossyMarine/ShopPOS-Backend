import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Receipt from "../models/Receipt.js";
import AuditLog from "../models/AuditLog.js";
import AdminSettings from "../models/AdminSettings.js";
import { buildOrderVat } from "../utils/vat.js";
import {
  PIN_RE, isWeakPin, isPinLocked, registerPinFailure, clearPinFailures, canUseDisplay,
} from "../utils/displayPin.js";
import {
  roomOf, resolveTill, setSnapshot, getSnapshot, refreshTills, revokeDisplays,
} from "../utils/displayState.js";

const cleanTill = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};
const TILL_RE = /^\d{5,7}$/;

/* ───────────── CASHIER SIDE ───────────── */

// GET /api/display/status
export const getStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("+displayPinHash");
    res.json({ pinSet: !!user.displayPinHash, till: await resolveTill(user) });
  } catch (e) { next(e); }
};

// PUT /api/display/pin   body: { pin, confirmPin, oldPin? }
export const setPin = async (req, res, next) => {
  try {
    const { pin, confirmPin, oldPin } = req.body;
    const user = await User.findById(req.user._id)
      .select("+password +displayPinHash +displayPinFailed +displayPinLockedUntil");

    if (!PIN_RE.test(pin || "")) return res.status(400).json({ message: "PIN must be exactly 6 digits" });
    if (pin !== confirmPin) return res.status(400).json({ message: "PINs don't match" });
    if (isWeakPin(pin)) return res.status(400).json({ message: "That PIN is too easy to guess" });

    if (user.displayPinHash) {
      if (isPinLocked(user)) return res.status(429).json({ message: "Too many attempts. Try again in a few minutes." });
      if (!oldPin || !(await bcrypt.compare(oldPin, user.displayPinHash))) {
        await registerPinFailure(user._id);
        return res.status(401).json({ message: "Old PIN is incorrect" });
      }
    }

    // PIN must never equal the password, otherwise the Dashboard-first rule
    // would silently swallow the PIN.
    if (await bcrypt.compare(pin, user.password)) {
      return res.status(400).json({ message: "PIN can't be the same as your password" });
    }

    user.displayPinHash = await bcrypt.hash(pin, 10);
    user.displayPinFailed = 0;
    user.displayPinLockedUntil = null;
    user.displaySessionVersion = (user.displaySessionVersion || 0) + 1;
    await user.save();

    revokeDisplays(req.app.get("io"), user._id); // old PIN's sessions end now
    res.json({ message: "Display PIN saved" });
  } catch (e) { next(e); }
};

// POST /api/display/cart   body: { items:[{productId, productName, imageUrl, unitPrice, quantity, vatClass}] }
// The SERVER prices it with buildOrderVat + AdminSettings.vat — same math as checkout.
export const pushCart = async (req, res, next) => {
  try {
    const io = req.app.get("io");
    const items = (Array.isArray(req.body.items) ? req.body.items : [])
      .slice(0, 300)
      .map((i) => {
        const unitPrice = Number(i.unitPrice);
        const quantity = Number(i.quantity);
        return {
          productId: String(i.productId || ""),
          productName: String(i.productName || "").slice(0, 120),
          imageUrl: typeof i.imageUrl === "string" && i.imageUrl.startsWith("https://") ? i.imageUrl : null,
          unitPrice,
          quantity,
          lineTotal: unitPrice * quantity,
          vatClass: ["zero", "exempt"].includes(i.vatClass) ? i.vatClass : "standard",
        };
      })
      .filter((i) => i.productName && i.unitPrice >= 0 && i.quantity > 0);

    if (!items.length) {
      setSnapshot(req.user._id, { phase: "idle" });
      io.to(roomOf(req.user._id)).emit("display:idle");
      return res.json({ ok: true });
    }

    const settings = await AdminSettings.getSettings();
    const vat = buildOrderVat(items, settings.vat);
    const totals = { ...vat, totalQty: items.reduce((s, i) => s + i.quantity, 0) };

    setSnapshot(req.user._id, { phase: "cart", cart: items, totals });
    io.to(roomOf(req.user._id)).emit("display:cart", { cart: items, totals });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

// POST /api/display/bill   body: { receiptId }
// Call after checkout starts (unpaid), and again once paid. Status comes from the DB.
export const pushBill = async (req, res, next) => {
  try {
    const io = req.app.get("io");
    const receipt = await Receipt.findById(req.body.receiptId);
    if (!receipt) return res.status(404).json({ message: "Bill not found" });

    const myBranch = req.user.isAdmin ? req.user.selectedBranch : req.user.branch;
    if (String(receipt.branch) !== String(myBranch)) {
      return res.status(403).json({ message: "Not your branch" });
    }

    const prev = getSnapshot(req.user._id);
    const paid = receipt.amountPaid || 0;
    const bill = {
      billId: receipt.billId,
      status: receipt.status,
      subtotal: receipt.subtotal,
      vatEnabled: receipt.vatEnabled,
      vatRate: receipt.vatRate,
      vatAmount: receipt.vatAmount,
      totalDue: receipt.totalDue,
      amountPaid: paid,
      balanceDue: Math.max(0, receipt.totalDue - paid),
    };
    const snap = { phase: "bill", bill, cart: prev.cart || [], totals: prev.totals || null };
    setSnapshot(req.user._id, snap);
    io.to(roomOf(req.user._id)).emit("display:bill", snap);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/* ───────────── DISPLAY SIDE (displayToken cookie) ───────────── */

// GET /api/display/me
export const displayMe = async (req, res, next) => {
  try {
    const settings = await AdminSettings.getSettings();
    res.json({
      fullName: req.user.fullName,
      storeName: settings.storeName,
      till: await resolveTill(req.user),
    });
  } catch (e) { next(e); }
};

// GET /api/display/socket-ticket — 2-minute ticket used to join this cashier's room
export const socketTicket = (req, res) => {
  const ticket = jwt.sign({ id: req.user._id, scope: "display-socket" }, process.env.JWT_SECRET, { expiresIn: "2m" });
  res.json({ ticket });
};

// POST /api/display/logout
export const displayLogout = (req, res) => {
  res.clearCookie("displayToken");
  res.json({ message: "Display signed out" });
};

/* ───────────── ADMIN / BRANCH MANAGER ───────────── */

const loadManageable = async (req) => {
  const target = await User.findById(req.params.id).select("+displayPinHash +displayPinLockedUntil");
  if (!target || !canUseDisplay(target) || target.isAdmin) return { err: [404, "Cashier not found"] };
  if (!req.user.isAdmin && String(target.branch) !== String(req.user.branch)) {
    return { err: [403, "You can only manage cashiers in your own branch"] };
  }
  return { target };
};

// GET /api/display/cashiers/:id
export const getCashierDisplay = async (req, res, next) => {
  try {
    const { target, err } = await loadManageable(req);
    if (err) return res.status(err[0]).json({ message: err[1] });
    res.json({
      pinSet: !!target.displayPinHash,
      lockedUntil: isPinLocked(target) ? target.displayPinLockedUntil : null,
      tillNumber: target.displayTillNumber || "",
      tillName: target.displayTillName || "",
      resolved: await resolveTill(target),
    });
  } catch (e) { next(e); }
};

// PATCH /api/display/cashiers/:id/till   body: { tillNumber, tillName }  (empty = clear)
export const setCashierTill = async (req, res, next) => {
  try {
    const { target, err } = await loadManageable(req);
    if (err) return res.status(err[0]).json({ message: err[1] });

    const tillNumber = cleanTill(req.body.tillNumber);
    const tillName = cleanTill(req.body.tillName);
    if (tillNumber && !TILL_RE.test(tillNumber)) {
      return res.status(400).json({ message: "Till number must be 5–7 digits" });
    }

    target.displayTillNumber = tillNumber;
    target.displayTillName = tillNumber ? tillName : null;
    await target.save();

    await AuditLog.create({
      entityType: "DisplayTill", entityId: target._id, action: "till_changed",
      performedBy: req.user._id, branch: target.branch,
      details: { tillNumber, tillName: target.displayTillName },
    });

    const io = req.app.get("io");
    io.to(roomOf(target._id)).emit("display:till", await resolveTill(target));
    res.json({ resolved: await resolveTill(target) });
  } catch (e) { next(e); }
};

// POST /api/display/cashiers/:id/reset-pin
export const resetCashierPin = async (req, res, next) => {
  try {
    const { target, err } = await loadManageable(req);
    if (err) return res.status(err[0]).json({ message: err[1] });

    target.displayPinHash = undefined;
    target.displayPinFailed = 0;
    target.displayPinLockedUntil = null;
    target.displaySessionVersion = (target.displaySessionVersion || 0) + 1;
    await target.save();

    await AuditLog.create({
      entityType: "DisplayPin", entityId: target._id, action: "reset",
      performedBy: req.user._id, branch: target.branch, details: {},
    });

    revokeDisplays(req.app.get("io"), target._id);
    res.json({ message: "Display PIN reset. The cashier must set a new one." });
  } catch (e) { next(e); }
};
