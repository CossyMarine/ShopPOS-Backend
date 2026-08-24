// utils/AppError.js
// A thin wrapper for errors we throw on purpose (validation, auth, not-found,
// conflict) so the centralized handler knows it's "expected" and safe to
// show statusCode + message to the client, instead of a raw 500.
export class AppError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.isOperational = true; // distinguishes "we threw this" from bugs
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Convenience factories mirroring the messages already scattered across
// controllers, so converting a controller is mostly a find/replace.
export const notFound = (what = "Resource") =>
  new AppError(`${what} not found`, 404);

export const badRequest = (message, details) =>
  new AppError(message, 400, details);

export const unauthorized = (message = "Unauthorized") =>
  new AppError(message, 401);

export const forbidden = (message = "Forbidden") =>
  new AppError(message, 403);

export const conflict = (message = "Conflict") =>
  new AppError(message, 409);
