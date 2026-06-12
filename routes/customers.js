const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Customer = require("../models/Customer");

// GET /api/customers?phone=XXXXXXXXXX — lookup by phone
router.get("/", auth, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json(null);
    // Normalize: strip spaces, dashes, +91 prefix
    const normalized = phone.replace(/\D/g, "").replace(/^91/, "").slice(-10);
    const customer = await Customer.findOne({
      phone: { $regex: normalized + "$" }
    });
    res.json(customer || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers/upsert — upsert by phone (called internally on order save)
router.post("/upsert", auth, async (req, res) => {
  try {
    const { phone, name, email, address, channel, lastOrderId } = req.body;
    if (!phone) return res.json(null);
    const normalized = phone.replace(/\D/g, "").replace(/^91/, "").slice(-10);
    if (!normalized || normalized.length < 6) return res.json(null);

    const customer = await Customer.findOneAndUpdate(
      { phone: { $regex: normalized + "$" } },
      { phone: normalized, name, email, address, channel, lastOrderId, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
