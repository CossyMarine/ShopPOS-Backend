// utils/vat.js
// Pure VAT math shared by order creation and receipt generation, so the
// cart total and the printed receipt can never disagree.

// Computes VAT for one order line given its product's vatClass.
// lineTotal is ALWAYS the pre-VAT amount when priceMode is "exclusive",
// and the VAT-inclusive amount when priceMode is "inclusive" — the caller
// (buildOrderVat) handles which one it's passing in.
const lineVat = ({ lineTotal, vatClass, rate, priceMode }) => {
  if (vatClass === "zero" || vatClass === "exempt") {
    return { vatAmount: 0, netAmount: lineTotal };
  }

  if (priceMode === "inclusive") {
    // lineTotal already contains VAT — back it out.
    const netAmount = lineTotal / (1 + rate / 100);
    return { vatAmount: Number((lineTotal - netAmount).toFixed(2)), netAmount: Number(netAmount.toFixed(2)) };
  }

  // exclusive — lineTotal is pre-VAT, VAT is added on top.
  const vatAmount = Number((lineTotal * (rate / 100)).toFixed(2));
  return { vatAmount, netAmount: lineTotal };
};

// items: order items with { lineTotal, vatClass } already attached per line.
// settings: the AdminSettings.vat sub-document (or plain object).
// Returns totals to store on the order/receipt.
export const buildOrderVat = (items, vatSettings) => {
  const { enabled, rate, priceMode } = vatSettings || {};

  if (!enabled) {
    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    return { vatEnabled: false, vatRate: 0, priceMode: "exclusive", subtotal, vatAmount: 0, totalDue: subtotal };
  }

  let vatAmount = 0;
  let netSubtotal = 0;

  for (const item of items) {
    const { vatAmount: lineVatAmount, netAmount } = lineVat({
      lineTotal: item.lineTotal,
      vatClass: item.vatClass || "standard",
      rate,
      priceMode,
    });
    vatAmount += lineVatAmount;
    netSubtotal += netAmount;
  }

  vatAmount = Number(vatAmount.toFixed(2));
  netSubtotal = Number(netSubtotal.toFixed(2));

  // exclusive: customer pays net + vat. inclusive: customer pays exactly the
  // line totals already entered (vatAmount is informational, for KRA/reporting).
  const totalDue = priceMode === "inclusive"
    ? Number(items.reduce((sum, i) => sum + i.lineTotal, 0).toFixed(2))
    : Number((netSubtotal + vatAmount).toFixed(2));

  return { vatEnabled: true, vatRate: rate, priceMode, subtotal: netSubtotal, vatAmount, totalDue };
};
