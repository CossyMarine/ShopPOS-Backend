// middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Shift from "../models/Shift.js";

// Protect routes — reads the httpOnly cookie set on login
export const protect = async (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });

    // A Display token must never work as a dashboard token
    if (decoded.scope) {
      return res.status(401).json({ message: "Not authorized, token failed" });
    }

    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({ message: "Not authorized, user not found" });
    }

    if (!user.isActive) {
      return res
        .status(403)
        .json({ message: "Your account has been deactivated. Contact your admin." });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Auth middleware error:", error.message);
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};

// Display sessions: separate cookie, scope-checked, revoked by session version.
export const protectDisplay = async (req, res, next) => {
  const token = req.cookies?.displayToken;
  if (!token) return res.status(401).json({ message: "Display not signed in" });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (d.scope !== "display") throw new Error("wrong scope");
    const user = await User.findById(d.id).select("-password +displayPinHash");
    if (
      !user || !user.isActive || !user.displayPinHash ||
      (user.displaySessionVersion || 0) !== d.v
    ) {
      res.clearCookie("displayToken");
      return res.status(401).json({ message: "Display session ended" });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: "Display session ended" });
  }
};

export const hasRole = (user, role) =>
  !!user && (user.role === role || (user.extraRoles || []).includes(role));

export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    if (allowedRoles.includes("admin") && req.user.isAdmin) {
      return next();
    }
    if (
      allowedRoles.includes(req.user.role) ||
      (req.user.extraRoles || []).some((r) => allowedRoles.includes(r))
    ) {
      return next();
    }
    return res.status(403).json({ message: "Insufficient permissions" });
  };
};

export const requirePermission = (key) => (req, res, next) => {
  if (!req.user) return res.status(403).json({ message: "Insufficient permissions" });
  if (req.user.isAdmin) return next();
  if (req.user.role !== "accountant") return next();
  if (req.user.permissions?.[key]) return next();
  return res.status(403).json({ message: "You don't have access to this section" });
};

export const requireOpenShift = async (req, res, next) => {
  try {
    const shift = await Shift.findOne({ openedBy: req.user._id, status: "open" });
    if (req.user?.isAdmin) {
      if (shift) req.shift = shift;
      return next();
    }
    if (!shift) {
      return res.status(403).json({ message: "Open your shift before processing payments." });
    }
    req.shift = shift;
    next();
  } catch (error) {
    res.status(500).json({ message: "Failed to verify shift status", error: error.message });
  }
};

export const sameBranch = (req, res, next) => {
  if (req.user?.isAdmin) return next();

  req.body = req.body || {};

  const targetBranch =
    req.params.branchId || req.body.branch || req.query.branch;

  if (!req.user.branch) {
    return res.status(403).json({ message: "Your account has no assigned branch" });
  }

  if (!targetBranch) {
    req.body.branch = String(req.user.branch);
    req.query.branch = String(req.user.branch);
    return next();
  }

  if (String(req.user.branch) !== String(targetBranch)) {
    return res.status(403).json({ message: "You can only access your own branch" });
  }

  next();
};
