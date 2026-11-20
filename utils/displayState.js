import User from "../models/User.js";
import Branch from "../models/Branch.js";
import AdminSettings from "../models/AdminSettings.js";

export const roomOf = (userId) => `display:${userId}`;

// cashier's own till → branch till → store (settings) till → none.
// Number and name always come from the SAME level, so a name never
// ends up beside someone else's till number.
export const resolveTill = async (user) => {
  const branchId = user.isAdmin ? user.selectedBranch : user.branch;
  const [branch, settings] = await Promise.all([
    branchId ? Branch.findById(branchId).select("tillNumber tillName") : null,
    AdminSettings.getSettings(),
  ]);
  const levels = [
    { number: user.displayTillNumber, name: user.displayTillName, source: "cashier" },
    { number: branch?.tillNumber, name: branch?.tillName, source: "branch" },
    { number: settings.tillNumber, name: settings.tillName, source: "store" },
  ];
  const hit = levels.find((l) => l.number);
  return hit
    ? { tillNumber: hit.number, tillName: hit.name || null, source: hit.source }
    : { tillNumber: null, tillName: null, source: null };
};

// Last known screen per cashier, so a refreshed/late Display catches up.
// In-memory: fine for one server instance (use Redis if you scale out).
const snapshots = new Map();
export const setSnapshot = (userId, snap) => snapshots.set(String(userId), snap);
export const getSnapshot = (userId) => snapshots.get(String(userId)) || { phase: "idle" };
export const clearSnapshot = (userId) => snapshots.delete(String(userId));

export const getDisplayState = async (userId) => {
  const user = await User.findById(userId);
  return { till: user ? await resolveTill(user) : null, ...getSnapshot(userId) };
};

// Push a fresh till to every OPEN display (admin changed a till)
export const refreshTills = async (io, filter = {}) => {
  const users = await User.find({
    isActive: true,
    $or: [{ role: "cashier" }, { extraRoles: "cashier" }, { isAdmin: true }],
    ...filter,
  }).select("branch selectedBranch isAdmin displayTillNumber displayTillName");
  for (const u of users) {
    if (!io.sockets.adapter.rooms.has(roomOf(u._id))) continue;
    io.to(roomOf(u._id)).emit("display:till", await resolveTill(u));
  }
};

// PIN reset/change: kick every open Display for this cashier
export const revokeDisplays = (io, userId) => {
  clearSnapshot(userId);
  io.to(roomOf(userId)).emit("display:revoked");
  io.in(roomOf(userId)).disconnectSockets(true);
};
