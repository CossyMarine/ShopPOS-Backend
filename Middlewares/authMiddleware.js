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

// Restrict a route to specific roles.
// Pass "admin" to require isAdmin === true; pass "kitchen"/"waiter"/"accountant"
// to require that exact `role`. e.g. authorize("admin", "waiter")
export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    if (allowedRoles.includes("admin") && req.user.isAdmin) {
      return next();
    }
    if (allowedRoles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ message: "Insufficient permissions" });
  };
};

// Gate a route behind one of an accountant's toggleable permissions.
// Admins always pass — permissions only apply to role: "accountant".
export const requirePermission = (key) => (req, res, next) => {
  if (!req.user) return res.status(403).json({ message: "Insufficient permissions" });
  if (req.user.isAdmin) return next();
  if (req.user.role !== "accountant") return next(); // only accountants are permission-gated
  if (req.user.permissions?.[key]) return next();
  return res.status(403).json({ message: "You don't have access to this section" });
};

// Blocks payment-processing routes unless the accountant has an open shift.
// Admins bypass this — they aren't shift-gated.
export const requireOpenShift = async (req, res, next) => {
  if (req.user?.isAdmin) return next();
  try {
    const shift = await Shift.findOne({ openedBy: req.user._id, status: "open" });
    if (!shift) {
      return res.status(403).json({ message: "Open your shift before processing payments." });
    }
    req.shift = shift; // handy for controllers to stamp receipt.shift
    next();
  } catch (error) {
    res.status(500).json({ message: "Failed to verify shift status", error: error.message });
  }
};

// authorize(): "admin" still means isAdmin === true (Super Admin, bypasses branch checks).
// Pass exact roles otherwise, e.g. authorize("admin", "branchManager", "cashier")

// NEW — restricts a route to the user's own branch.
// Super Admin bypasses entirely. Everyone else must operate within req.user.branch.
// Expects the target branch id at req.params.branchId, req.body.branch, or req.query.branch.
export const sameBranch = (req, res, next) => {
  if (req.user?.isAdmin) return next();

  const targetBranch =
    req.params.branchId || req.body.branch || req.query.branch;

  if (!req.user.branch) {
    return res.status(403).json({ message: "Your account has no assigned branch" });
  }

  // No branch specified on the request = scope automatically to the user's own branch
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
