const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Deal = require("../models/Deal");

// GET /api/deals — salesperson sees own, admin sees all
router.get("/", auth, async (req, res) => {
  try {
    const filter = req.user.role === "admin" ? {} : { salesperson: req.user.name };
    const deals = await Deal.find(filter).sort({ updatedAt: -1 });
    res.json(deals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deals — create deal
router.post("/", auth, async (req, res) => {
  try {
    const deal = new Deal({ ...req.body, salesperson: req.body.salesperson || req.user.name });
    await deal.save();
    res.status(201).json(deal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/deals/:id — update stage, lastContacted, lostReason, linkedOrderId
router.patch("/:id", auth, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    // Salesperson can only update their own deals
    if (req.user.role !== "admin" && deal.salesperson !== req.user.name)
      return res.status(403).json({ error: "Not authorized" });
    Object.assign(deal, req.body);
    deal.updatedAt = new Date();
    await deal.save();
    res.json(deal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deals/:id/log — append a log entry
router.post("/:id/log", auth, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    deal.logs.push({ text: req.body.text, author: req.user.name });
    deal.updatedAt = new Date();
    await deal.save();
    res.json(deal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/deals/:id — admin only
router.delete("/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    await Deal.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
