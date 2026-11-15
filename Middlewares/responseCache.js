// Middlewares/responseCache.js
//
// Tiny in-memory GET response cache for heavy read endpoints.
//
// - Keyed by URL + query + who is asking (Super Admin, or a specific branch),
//   so one branch manager can never be served another branch's numbers.
// - Only 200 responses are stored; errors always pass straight through.
// - ?fresh=1 skips the cached copy and refreshes it (used by the Refresh button).
// - Per-process memory. With several server instances each keeps its own copy,
//   which is fine for a 30-second window.

const store = new Map(); // key -> { expires, body }
const MAX_ENTRIES = 200;

const prune = (now) => {
  if (store.size <= MAX_ENTRIES) return;
  for (const [k, v] of store) if (v.expires <= now) store.delete(k);
  // still too big (everything unexpired)? drop the oldest entries
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
};

export const responseCache = ({ ttlMs = 30_000, when = () => true } = {}) => (req, res, next) => {
  if (req.method !== "GET" || !when(req)) return next();

  const fresh = req.query.fresh === "1";
  const scope = req.user?.isAdmin ? "admin" : `branch:${req.user?.branch}`;
  const { fresh: _omit, ...rest } = req.query;
  const key = `${req.baseUrl}${req.path}|${scope}|${JSON.stringify(Object.entries(rest).sort())}`;

  const now = Date.now();
  const hit = store.get(key);
  if (!fresh && hit && hit.expires > now) {
    res.set("X-Cache", "HIT");
    return res.status(200).json(hit.body);
  }

  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      const t = Date.now();
      store.set(key, { expires: t + ttlMs, body });
      prune(t);
    }
    return send(body);
  };
  res.set("X-Cache", fresh ? "BYPASS" : "MISS");
  next();
};
