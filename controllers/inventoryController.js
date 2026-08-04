// controllers/inventoryController.js
import InventoryUnit from "../models/InventoryUnit.js";
import Product from "../models/Product.js";
import { logStart, logSuccess, logError } from "../utils/requestLogger.js";

/* =================================================
   UNITS — admin-defined measurement units, used by Product.unit
================================================= */

// @desc    Get all measurement units
// @route   GET /api/inventory/units
// @access  Protected — admin, branchManager, storekeeper, cashier
export const getUnits = async (req, res) => {
  try {
    logStart("inventory", "Loading units");
    const units = await InventoryUnit.find().sort({ name: 1 });
    logSuccess("inventory", "Units loaded", { count: units.length });
    res.json(units);
  } catch (error) {
    logError("inventory", "Error fetching units", error);
    res.status(500).json({ message: "Failed to fetch units" });
  }
};

// @desc    Create a measurement unit (e.g. Kg, Litre, Piece, Pack)
// @route   POST /api/inventory/units
// @access  Protected — admin, branchManager, storekeeper
export const createUnit = async (req, res) => {
  try {
    const { name, abbreviation } = req.body;
    logStart("inventory", "Creating unit", { name, abbreviation });

    if (!name || !abbreviation) {
      console.warn("[inventory] ⚠️ Missing name or abbreviation");
      return res.status(400).json({ message: "Name and abbreviation are required" });
    }
    const unit = await InventoryUnit.create({ name, abbreviation });

    logSuccess("inventory", "Unit created", { unitId: unit._id, name });
    res.status(201).json(unit);
  } catch (error) {
    logError("inventory", "Error creating unit", error);
    res.status(500).json({ message: "Failed to create unit" });
  }
};

// @desc    Delete a measurement unit — blocked if any product still uses it
// @route   DELETE /api/inventory/units/:id
// @access  Protected — admin
export const deleteUnit = async (req, res) => {
  try {
    const { id } = req.params;
    logStart("inventory", "Deleting unit", { unitId: id });

    const inUse = await Product.exists({ unit: id });
    if (inUse) {
      console.warn(`[inventory] ⚠️ Unit ${id} still in use by a product — blocked`);
      return res.status(400).json({ message: "Unit is in use by one or more products" });
    }
    const unit = await InventoryUnit.findByIdAndDelete(id);
    if (!unit) {
      console.warn(`[inventory] ⚠️ Unit not found: ${id}`);
      return res.status(404).json({ message: "Unit not found" });
    }

    logSuccess("inventory", "Unit deleted", { unitId: id });
    res.json({ message: "Unit deleted" });
  } catch (error) {
    logError("inventory", "Error deleting unit", error);
    res.status(500).json({ message: "Failed to delete unit" });
  }
};
