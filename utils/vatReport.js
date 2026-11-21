// utils/vatReport.js
// Gives every receipt LINE a VAT split, including receipts sold while VAT was OFF.
//
// - Sold with VAT on:  use the snapshot on the receipt (vatRate / priceMode).
// - Sold with VAT off: buildOrderVat stored vatAmount 0, so derive the split from
//   lineTotal + vatClass using the CURRENT rate, treating the price the customer
//   paid as VAT-inclusive. Revenue never changes, only the net/VAT split.
//
// Change to "exclusive" if VAT-off shops priced their goods before tax.
export const OFF_PERIOD_PRICE_BASIS = "inclusive";

export const vatLineStages = (currentRate) => {
  const offIncl = OFF_PERIOD_PRICE_BASIS === "inclusive";
  return [
    {
      $addFields: {
        _std: { $eq: [{ $ifNull: ["$items.vatClass", "standard"] }, "standard"] },
        _derived: { $not: [{ $ifNull: ["$vatEnabled", false] }] },
      },
    },
    {
      $addFields: {
        _rate: { $cond: ["$_derived", currentRate, { $ifNull: ["$vatRate", 0] }] },
        _incl: { $cond: ["$_derived", offIncl, { $eq: ["$priceMode", "inclusive"] }] },
      },
    },
    {
      $addFields: {
        lineNet: {
          $cond: [
            { $and: ["$_std", "$_incl"] },
            { $divide: ["$items.lineTotal", { $add: [1, { $divide: ["$_rate", 100] }] }] },
            "$items.lineTotal",
          ],
        },
      },
    },
    {
      $addFields: {
        lineVat: {
          $cond: [
            "$_std",
            {
              $cond: [
                "$_incl",
                { $subtract: ["$items.lineTotal", "$lineNet"] },
                { $multiply: ["$items.lineTotal", { $divide: ["$_rate", 100] }] },
              ],
            },
            0, // zero-rated and exempt lines never carry VAT
          ],
        },
      },
    },
    // What the customer actually handed over for this line
    { $addFields: { linePaid: { $add: ["$lineNet", "$lineVat"] } } },
  ];
};

// For the breakdowns (top items, branches, categories): always provides
// lineNet / lineVat / linePaid. VAT on -> the real split. VAT off -> lineNet is
// just lineTotal, so nothing changes for shops that don't use VAT.
export const salesStages = (vatOn, rate) =>
  vatOn
    ? vatLineStages(rate)
    : [
        {
          $addFields: {
            lineNet: "$items.lineTotal",
            lineVat: { $literal: 0 },
            linePaid: "$items.lineTotal",
            _derived: { $literal: false },
          },
        },
      ];
