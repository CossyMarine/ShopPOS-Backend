import User from "../models/User.js";

export const PIN_RE = /^\d{6}$/;
const WEAK = new Set(["123456", "654321", "012345", "123123"]);
export const isWeakPin = (p) => WEAK.has(p) || /^(\d)\1{5}$/.test(p);

export const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export const canUseDisplay = (u) =>
  !!u && (u.isAdmin || u.role === "cashier" || (u.extraRoles || []).includes("cashier"));

export const isPinLocked = (u) =>
  !!u.displayPinLockedUntil && u.displayPinLockedUntil > new Date();

export const registerPinFailure = async (userId) => {
  const u = await User.findByIdAndUpdate(userId, { $inc: { displayPinFailed: 1 } }, { new: true })
    .select("+displayPinFailed");
  if (u && u.displayPinFailed >= MAX_FAILS) {
    await User.updateOne(
      { _id: userId },
      { displayPinFailed: 0, displayPinLockedUntil: new Date(Date.now() + LOCK_MS) }
    );
  }
};

export const clearPinFailures = (userId) =>
  User.updateOne({ _id: userId }, { displayPinFailed: 0, displayPinLockedUntil: null });
