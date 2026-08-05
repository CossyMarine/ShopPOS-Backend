// utils/resolveWage.js
import PayrollSettings from "../models/PayrollSettings.js";

const RATE_FIELDS = ["hourlyRate", "overtimeMultiplier", "dailyRateWeekday", "dailyRateWeekend", "monthlySalary", "commissionRate"];
const SCHEDULE_FIELDS = ["shiftStart", "shiftEnd", "disburseAfterHours", "intervalDays", "payDay"];

export const resolveEffectiveWage = async (wage) => {
  const branchSettings = await PayrollSettings.findOne({ branch: wage.branch });
  const globalSettings = branchSettings ? null : await PayrollSettings.findOne({ branch: null });
  const settings = branchSettings || globalSettings;

  const effective = wage.toObject ? wage.toObject() : { ...wage };

  if (wage.useOrgDefaultRate && settings) {
    RATE_FIELDS.forEach((f) => { effective[f] = settings[f]; });
  }

  effective.schedule = {};
  SCHEDULE_FIELDS.forEach((f) => {
    effective.schedule[f] = wage.schedule?.[f] ?? settings?.schedule?.[f] ?? null;
  });

  effective.assumeShiftCheck = settings?.assumeShiftCheck ?? true;
  return effective;
};
