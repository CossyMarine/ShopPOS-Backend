// controllers/reminderController.js
import Reminder from "../models/Reminder.js";
import { notFound } from "../utils/AppError.js";

const FIELDS = ["title", "amount", "due", "repeat", "day", "snoozeUntil", "done", "doneAt"];
const pick = (body) => FIELDS.reduce((o, k) => (body[k] !== undefined ? { ...o, [k]: body[k] } : o), {});

// GET /api/reminders — own reminders; completed ones older than 90 days are hidden
export const getReminders = async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 90 * 864e5);
    const list = await Reminder.find({
      owner: req.user._id,
      $or: [{ done: false }, { doneAt: { $gte: cutoff } }],
    })
      .sort({ due: 1 })
      .limit(500)
      .lean();
    res.json(list);
  } catch (error) {
    next(error);
  }
};

// POST /api/reminders
export const createReminder = async (req, res, next) => {
  try {
    const doc = await Reminder.create({ ...pick(req.body), owner: req.user._id });
    res.status(201).json(doc);
  } catch (error) {
    next(error);
  }
};

// PATCH /api/reminders/:id
export const updateReminder = async (req, res, next) => {
  try {
    const doc = await Reminder.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { $set: pick(req.body) },
      { new: true, runValidators: true }
    );
    if (!doc) throw notFound("Reminder");
    res.json(doc);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/reminders/:id
export const deleteReminder = async (req, res, next) => {
  try {
    const doc = await Reminder.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!doc) throw notFound("Reminder");
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};
