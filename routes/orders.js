const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Order = require("../models/Order");
const { notifyNewOrder } = require("../utils/email");

// GET /api/orders — get all orders
router.get("/", auth, async (req, res) => {
  try {
    const { channel, stage, includeArchived } = req.query;
    let filter = {};
    if (channel) filter.channel = channel;
    // by default exclude archived — pass ?includeArchived=true to get everything
    if (!includeArchived) filter.status = { $ne: "archived" };
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

// GET /api/orders/next-id?channel=BL — returns next sequential order ID for a channel
router.get("/next-id", auth, async (req, res) => {
  try {
    const prefixes = { Bangalore: "BL", Pune: "PU", Jodhpur: "JD", Website: "WB", Wholesale: "WS" };
    const prefix = prefixes[req.query.channel];
    if (!prefix) return res.status(400).json({ error: "Invalid channel" });
    const orders = await Order.find({ id: new RegExp(`^${prefix}-`) }, { id: 1 });
    const nums = orders.map(o => parseInt(o.id.replace(`${prefix}-`, "")) || 0).filter(n => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    res.json({ id: `${prefix}-${String(next).padStart(4, "0")}` });
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

// PUT /api/orders/:id — full order update (handles id rename)
router.put("/:id", auth, async (req, res) => {
  try {
    const { id: newId, ...rest } = req.body;
    const updateData = { ...rest, updatedAt: new Date() };
    // If a new id is provided and it's different, update the id field too
    if (newId && newId !== req.params.id) {
      const conflict = await Order.findOne({ id: newId });
      if (conflict) return res.status(409).json({ error: `Order ID ${newId} already exists` });
      updateData.id = newId;
    }
    const order = await Order.findOneAndUpdate(
      { id: req.params.id },
      updateData,
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