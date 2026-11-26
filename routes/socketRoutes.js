// routes/socketRoutes.js
import express from "express";
import jwt from "jsonwebtoken";
import { protect } from "../Middlewares/authMiddleware.js";

const router = express.Router();

// @desc    Short-lived ticket a signed-in client hands to Socket.IO.
//          Fetched through /api (so the first-party cookie authenticates it),
//          then used in io(url, { auth: { ticket } }) against the backend
//          directly. scope "socket" means it can't be used as a login
//          cookie (protect rejects any scoped token) or as a Display ticket.
// @route   GET /api/socket/ticket
// @access  Protected — any signed-in user
router.get("/ticket", protect, (req, res) => {
  const ticket = jwt.sign(
    { id: req.user._id, scope: "socket" },
    process.env.JWT_SECRET,
    { expiresIn: "2m" }
  );
  res.json({ ticket });
});

export default router;
