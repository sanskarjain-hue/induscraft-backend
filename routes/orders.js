const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Order = require("../models/Order");
const { notifyNewOrder } = require("../utils/email");

// GET /api/orders — get all orders
router.get("/", auth, async (req, res) => {
  try {
    const { channel, stage } = req.query;
    let filter = {};
    if (channel) filter.channel = channel;
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/:id
router.get("/:id", auth, async (req, res) => {
  try {
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders — create order
router.post("/", auth, async (req, res) => {
  try {
    if (!["admin", "sales"].includes(req.user.role))
      return res.status(403).json({ error: "Not authorized" });
    const order = new Order({ ...req.body, createdBy: req.user.id });
    await order.save();
    notifyNewOrder(order).catch(err => console.error("Email failed:", err.message));
    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/orders/:id — full order update
router.put("/:id", auth, async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate(
      { id: req.params.id },
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id/item/:itemId/stage — advance item stage
router.patch("/:id/item/:itemId/stage", auth, async (req, res) => {
  try {
    const { stageIndex, finishingProgress, qcStatus, qcNotes, packetCount } = req.body;
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const item = order.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });

    if (stageIndex !== undefined) item.stageIndex = stageIndex;
    if (finishingProgress !== undefined) item.finishingProgress = finishingProgress;
    if (qcStatus !== undefined) item.qcStatus = qcStatus;
    if (qcNotes !== undefined) item.qcNotes = qcNotes;
    if (packetCount !== undefined) item.packetCount = packetCount;
    order.updatedAt = new Date();

    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id/item/:itemId/vendor — assign vendor
router.patch("/:id/item/:itemId/vendor", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });

    const { vendorId, vendorCost, committedDate } = req.body;
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const item = order.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });

    item.vendorId = vendorId;
    if (vendorCost !== undefined) item.vendorCost = vendorCost;
    if (committedDate !== undefined) item.committedDate = committedDate;
    if (vendorId && item.stageIndex === 0) item.stageIndex = 1;
    order.updatedAt = new Date();

    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id/item/:itemId/flag — add problem flag
router.patch("/:id/item/:itemId/flag", auth, async (req, res) => {
  try {
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const item = order.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });

    item.flags.push(req.body);
    order.updatedAt = new Date();
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id/payment — add payment
router.patch("/:id/payment", auth, async (req, res) => {
  try {
    if (!["admin", "sales", "accountant"].includes(req.user.role))
      return res.status(403).json({ error: "Not authorized" });

    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.payments.push({ ...req.body, by: req.user.name });
    order.advance = order.payments.reduce((s, p) => s + p.amount, 0);
    order.updatedAt = new Date();
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id/dispatch — add dispatch details
router.patch("/:id/dispatch", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });

    const order = await Order.findOneAndUpdate(
      { id: req.params.id },
      { dispatchDetails: req.body, updatedAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id/delay — update item delivery date
router.patch("/:id/item/:itemId/delay", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });

    const { currentDelivery } = req.body;
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const item = order.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Item not found" });

    item.currentDelivery = currentDelivery;
    order.updatedAt = new Date();
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;