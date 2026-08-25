// controllers/settingsController.js
import AdminSettings from "../models/AdminSettings.js";
import { logStart, logSuccess } from "../utils/requestLogger.js";

// @desc    Get full admin settings
// @route   GET /api/settings
// @access  Protected — admin
export const getSettings = async (req, res, next) => {
  try {
    logStart("settings", "Loading admin settings");
    const settings = await AdminSettings.getSettings();
    logSuccess("settings", "Admin settings loaded");
    res.json(settings);
  } catch (error) {
    next(error);
  }
};

// @desc    Update admin settings (partial merge — send only what changed)
// @route   PATCH /api/settings
// @access  Protected — admin
export const updateSettings = async (req, res, next) => {
  const { tillNumber, tillName, whatsappNumber, callNumber, reward, vat, assumeTableNumberCustomer, assumeTableNumberWaiter, allowPrintingDuringPayment } = req.body;
  try {
    logStart("settings", "Updating admin settings", { fields: Object.keys(req.body) });

    const settings = await AdminSettings.getSettings();
    if (tillNumber !== undefined) settings.tillNumber = tillNumber;
    if (tillName !== undefined) settings.tillName = tillName;
    if (whatsappNumber !== undefined) settings.whatsappNumber = whatsappNumber;
    if (callNumber !== undefined) settings.callNumber = callNumber;
    if (assumeTableNumberCustomer !== undefined) settings.assumeTableNumberCustomer = assumeTableNumberCustomer;
    if (assumeTableNumberWaiter !== undefined) settings.assumeTableNumberWaiter = assumeTableNumberWaiter;
    if (allowPrintingDuringPayment !== undefined) settings.allowPrintingDuringPayment = allowPrintingDuringPayment;
    if (reward && typeof reward === "object") {
      const current = settings.reward.toObject ? settings.reward.toObject() : settings.reward;
      settings.reward = { ...current, ...reward };
    }
    if (vat && typeof vat === "object") {
      const current = settings.vat.toObject ? settings.vat.toObject() : settings.vat;
      settings.vat = { ...current, ...vat };
    }
    await settings.save();

    logSuccess("settings", "Admin settings updated");
    res.json(settings);
  } catch (error) {
    next(error);
  }
};

export const getPublicSettings = async (req, res, next) => {
  try {
    logStart("settings", "Loading public settings");
    const s = await AdminSettings.getSettings();
    logSuccess("settings", "Public settings loaded");
    res.json({
      tillNumber: s.tillNumber,
      tillName: s.tillName,
      whatsappNumber: s.whatsappNumber,
      callNumber: s.callNumber,
      assumeTableNumberCustomer: s.assumeTableNumberCustomer,
      assumeTableNumberWaiter: s.assumeTableNumberWaiter,
      allowPrintingDuringPayment: s.allowPrintingDuringPayment,
      reward: {
        enabled: s.reward.enabled,
        pointValueKes: s.reward.pointValueKes,
        targetPoints: s.reward.targetPoints,
        description: s.reward.description,
      },
      vat: {
        enabled: s.vat.enabled,
        rate: s.vat.rate,
        priceMode: s.vat.priceMode,
      },
    });
  } catch (error) {
    next(error);
  }
};
