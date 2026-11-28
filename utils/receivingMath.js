// utils/receivingMath.js — shared by backend and frontend (identical file)
export const VAT_RATE = 0.16; // fallback only; the real rate comes from Admin Settings (b.vatRate)
export const VAT_CLASSES = ["standard", "zero", "exempt"];
const num = (v) => Number(v) || 0;
export const r2 = (n) => Math.round(num(n) * 100) / 100;
export const r3 = (n) => Math.round(num(n) * 1000) / 1000;
export const r4 = (n) => Math.round(num(n) * 10000) / 10000;

export const baseAbbr = (p) => p.unit?.abbreviation || "pc";
export const stockOf = (p) => (p.batches || []).reduce((s, b) => s + b.quantity, 0);
export const allowsDecimals = (p) =>
  typeof p.allowDecimals === "boolean" ? p.allowDecimals : /^(kg|g|l|ltr|ml|m)$/i.test(baseAbbr(p));

// key 'b' = base unit, otherwise the pack _id
export const unitTable = (p) => {
  const t = { b: { qty: 1, name: baseAbbr(p) } };
  (p.packs || []).forEach((k) => { t[String(k._id)] = { qty: k.qty, name: k.name }; });
  return t;
};

// l = { items:[{key,qty}], priceUnit:'b'|packId|'total', price, discounts:[{type:'pct'|'amt'|'free',val,unit}], rejected, expiryDate }
export function calcLine(l, p) {
  const U = unitTable(p), err = [];
  const items = Array.isArray(l.items) ? l.items : [];
  let recv = 0; const bought = [];
  for (const it of items) {
    const u = U[it.key]; if (!u) { err.push("Unknown unit"); continue; }
    const q = num(it.qty);
    if (q < 0) err.push("Negative quantity");
    if (q > 0) { recv += q * u.qty; bought.push({ name: u.name, qty: q, unitQty: u.qty }); }
  }
  recv = r3(recv);

  const discs = Array.isArray(l.discounts) ? l.discounts : [];
  let freeBase = 0;
  discs.forEach((d) => {
    if (d.type !== "free") return;
    const u = U[d.unit]; if (!u) { err.push("Unknown unit on free goods"); return; }
    freeBase += num(d.val) * u.qty;
  });
  freeBase = r3(freeBase);

  const rej = Math.max(0, num(l.rejected));
  const paid = Math.max(0, r3(recv - rej));
  const added = r3(paid + freeBase);

  let unitPrice, gross;
  if (l.priceUnit === "total") { gross = num(l.price); unitPrice = paid > 0 ? gross / paid : 0; }
  else {
    const u = U[l.priceUnit || "b"]; if (!u) err.push("Unknown price unit");
    unitPrice = num(l.price) / (u ? u.qty : 1); gross = paid * unitPrice;
  }

  let rem = gross;
  const out = discs.map((d) => ({ type: d.type, val: num(d.val), unit: d.unit || null, unitName: U[d.unit]?.name || null, amount: 0 }));
  out.filter((d) => d.type === "pct").forEach((d) => { const a = rem * Math.min(d.val, 100) / 100; rem -= a; d.amount = a; });
  out.filter((d) => d.type === "amt").forEach((d) => { const a = Math.min(d.val, rem); rem -= a; d.amount = a; });
  out.filter((d) => d.type === "free").forEach((d) => { d.amount = d.val * (U[d.unit]?.qty || 1) * unitPrice; });

  if (recv <= 0 && freeBase <= 0) err.push("Enter the quantity received");
  else if (added <= 0) err.push("All rejected, nothing to add");
  if (rej > recv) err.push("Rejected is more than received");
  if (!allowsDecimals(p) && [...items.map((i) => num(i.qty)), rej, freeBase].some((x) => x % 1 !== 0)) err.push("Whole numbers only for this product");
  if (paid > 0 && !(num(l.price) > 0)) err.push("Enter the invoice price");
  if (p.perishable && !l.expiryDate) err.push("Expiry date required");
  if (l.expiryDate) {
    const d = new Date(l.expiryDate);
    if (isNaN(d)) err.push("Invalid expiry date");
    else { const t = new Date(); t.setHours(0, 0, 0, 0); if (d < t) err.push("Batch already expired"); }
  }

  return { recv, bought, freeBase, rej, paid, added, unitPrice, gross, disc: gross - rem, net: rem,
           freeValue: freeBase * unitPrice, discounts: out, errors: err };
}

// b = { lines, discPct, discAmt, delivery, vatOn, vatMode:'excl'|'incl', vatNR, vatRate }
//   vatRate = percent, e.g. 16 (from Admin Settings; falls back to VAT_RATE)
//   line.vatClass = optional override: 'standard' | 'zero' | 'exempt'
//                   (default: the product's own vatClass, else 'standard')
//
// VAT is worked out PER LINE. Only "standard" lines carry VAT, so a mixed
// invoice (e.g. bread/milk + soap) is handled correctly. The invoice-level
// "incl/excl" choice applies to the standard lines only.
export function calcDelivery(b, byId) {
  const errors = [];
  const rate = (num(b.vatRate) > 0 ? num(b.vatRate) : VAT_RATE * 100) / 100;

  const L = b.lines.map((line) => {
    const p = byId.get(String(line.product));
    const c = calcLine(line, p);
    c.errors.forEach((e) => errors.push(`${p.name}: ${e}`));
    c.vatClass = VAT_CLASSES.includes(line.vatClass)
      ? line.vatClass
      : (VAT_CLASSES.includes(p.vatClass) ? p.vatClass : "standard");
    return { line, p, c };
  });

  const sum = (f) => L.reduce((s, x) => s + f(x.c), 0);
  const sumNet = sum((c) => c.net), sumAdded = sum((c) => c.added), sumGross = sum((c) => c.gross);
  const lineDisc = sum((c) => c.disc), freeValue = sum((c) => c.freeValue);

  // Invoice-level discount, spread over the lines in proportion to their net value
  const ivP = Math.min(Math.max(num(b.discPct), 0), 100), ivA = Math.max(num(b.discAmt), 0);
  const dP = sumNet * ivP / 100, dA = Math.min(ivA, sumNet - dP), D = dP + dA;

  const del = Math.max(num(b.delivery), 0);
  const nr = !!(b.vatOn && b.vatNR); // VAT not recoverable: becomes part of the cost

  let vat = 0, exVat = 0, payable = 0;
  L.forEach(({ c }) => {
    const share = sumNet > 0 ? c.net / sumNet : (sumAdded > 0 ? c.added / sumAdded : 0);
    const after = c.net - D * share;                 // line value after all discounts
    const taxed = !!b.vatOn && c.vatClass === "standard";

    let ex = after, v = 0, pay = after;
    if (taxed) {
      if (b.vatMode === "incl") { ex = after / (1 + rate); v = after - ex; } // VAT already in the price
      else { v = after * rate; pay = after + v; }                            // add VAT on top
    }

    c.exVat = ex;                                    // value before VAT
    c.vat = v;                                       // input VAT on this line
    c.payable = pay;                                 // what you pay the supplier for this line
    c.landed = ex + (nr ? v : 0) + del * share;      // real cost of this line
    c.eff = c.added > 0 ? c.landed / c.added : 0;    // real cost per base unit

    vat += v; exVat += ex; payable += pay;
  });

  const total = payable + del;

  return { L, errors, totals: {
    gross: r2(sumGross), lineDisc: r2(lineDisc), invDisc: r2(D), free: r2(freeValue),
    exVat: r2(exVat), vat: r2(vat), delivery: r2(del), total: r2(total),
    saved: r2(lineDisc + D + freeValue),
  } };
      }
