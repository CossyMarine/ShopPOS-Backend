// utils/requestLogger.js
// Console logger for controller actions — mirrors the style already used in
// aiInsightsController: a "→ starting" line, a "✅ success" line, and on
// failure a detailed "❌" breakdown (Mongo validation/cast/duplicate-key
// specifics instead of just the generic error.message).
export const logStart = (tag, action, details = {}) => {
  const extra = Object.keys(details).length ? " " + JSON.stringify(details) : "";
  console.log(`[${tag}] → ${action}${extra}`);
};

export const logSuccess = (tag, action, details = {}) => {
  const extra = Object.keys(details).length ? " " + JSON.stringify(details) : "";
  console.log(`[${tag}] ✅ ${action}${extra}`);
};

export const logError = (tag, action, error) => {
  console.error(`[${tag}] ❌ ${action}:`, error.message);

  if (error.name === "ValidationError") {
    const fields = Object.keys(error.errors || {});
    console.error(`[${tag}] ❌ Mongoose validation failed on: ${fields.join(", ")}`);
    fields.forEach((f) => console.error(`[${tag}]    - ${f}: ${error.errors[f].message}`));
  } else if (error.name === "CastError") {
    console.error(`[${tag}] ❌ Cast error — path "${error.path}", value "${error.value}", expected ${error.kind}`);
  } else if (error.code === 11000) {
    console.error(`[${tag}] ❌ Duplicate key:`, JSON.stringify(error.keyValue));
  } else if (error.response?.data) {
    console.error(`[${tag}] ❌ Upstream error body:`, JSON.stringify(error.response.data));
  } else if (error.stack) {
    console.error(`[${tag}] ❌ Stack:`, error.stack.split("\n").slice(0, 3).join(" | "));
  }
};
