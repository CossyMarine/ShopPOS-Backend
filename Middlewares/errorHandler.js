// Middlewares/errorHandler.js
// Centralized error handler — registered LAST in app.js, after all routes.
// Reuses utils/requestLogger.js's logError so you keep its Mongo-specific
// parsing (ValidationError / CastError / duplicate key) instead of losing it.
import * as Sentry from "@sentry/node";
import { logError } from "../utils/requestLogger.js";

export const notFoundHandler = (req, res, next) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

export const errorHandler = (err, req, res, next) => {
  const tag = req.requestId ? `req:${req.requestId}` : "error";
  logError(tag, `${req.method} ${req.originalUrl}`, err);

  // Only report unexpected errors to Sentry — AppError (isOperational) is
  // normal control flow (validation, 404s, auth failures), not a bug.
  if (!err.isOperational) {
    Sentry.captureException(err, {
      tags: { requestId: req.requestId },
      extra: {
        method: req.method,
        path: req.originalUrl,
        userId: req.user?._id,
      },
    });
  }

  // Known, operational errors (AppError) — safe to expose statusCode/message.
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      message: err.message,
      ...(Object.keys(err.details || {}).length ? { details: err.details } : {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  }

  // Mongoose validation error → 400 with field messages
  if (err.name === "ValidationError") {
    const fields = Object.keys(err.errors || {});
    return res.status(400).json({
      message: "Validation failed",
      fields: fields.reduce((acc, f) => {
        acc[f] = err.errors[f].message;
        return acc;
      }, {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  }

  // Mongoose cast error (bad ObjectId etc.) → 400
  if (err.name === "CastError") {
    return res.status(400).json({
      message: `Invalid ${err.path}: ${err.value}`,
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  }

  // Mongo duplicate key → 409
  if (err.code === 11000) {
    return res.status(409).json({
      message: "Duplicate value",
      keyValue: err.keyValue,
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  }

  // Unknown/unexpected — don't leak internals to the client.
  return res.status(500).json({
    message: "Internal server error",
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
};
