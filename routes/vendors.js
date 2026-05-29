const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Vendor = require("../models/Vendor");

// GET /api/vendors
router.get("/", auth, async (req, res) => {
  try {
    const vendors = await Vendor.find().sort({ name: 1 });
    res.json(vendors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/:id
router.get("/:id", auth, async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });
    res.json(vendor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vendors — create vendor (admin only)
router.post("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });
    const vendor = new Vendor(req.body);
    await vendor.save();
    res.status(201).json(vendor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vendors/bulk — import multiple vendors
router.post("/bulk", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });
    const vendors = await Vendor.insertMany(req.body.vendors);
    res.status(201).json(vendors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/vendors/:id — update vendor
router.put("/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });
    res.json(vendor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
