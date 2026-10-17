const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Order = require("../models/Order");
const cloudinary = require("cloudinary").v2;
const { STRIP_PROJECTION, stripEnabled, restorePhotoData, clientView } = require("../utils/photoData");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Collects every Cloudinary publicId referenced anywhere in an order document —
// item images, measurement/raw/finishing/QC photos, and order-level sheet files.
// Used to clean up storage when an order is permanently deleted, so deleted orders
// don't leave orphaned files billing against the Cloudinary account indefinitely.
function collectPublicIds(order) {
  const ids = [];
  const collectFrom = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const f of arr) {
      if (f && f.publicId) ids.push(f.publicId);
    }
  };
  collectFrom(order.orderSheetFiles);
  for (const item of order.items || []) {
    collectFrom(item.images);
    collectFrom(item.measurementPhotos);
    collectFrom(item.rawPhotos);
    collectFrom(item.finishingPhotos);
    collectFrom(item.qcPhotos);
  }
  return ids;
}

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

// GET /api/orders — get all orders
router.get("/", auth, async (req, res) => {
  try {
    const { channel, stage, includeArchived } = req.query;
    let filter = {};
    if (channel) filter.channel = channel;
    if (!includeArchived) filter.status = { $ne: "archived" };
    // Legacy orders carry photos as base64 text inside the document (photo.data), which made this
    // list ~150 MB. The list leaves that out (see utils/photoData.js); a single order fetched by id
    // still returns everything. Set STRIP_PHOTO_DATA=false in the environment to go back to the old behaviour.
    const started = Date.now();
    let query = Order.find(filter);
    if (stripEnabled()) query = query.select(STRIP_PROJECTION);
    const orders = await query.sort({ createdAt: -1 });
    console.log(`[orders] list: ${orders.length} orders in ${Date.now() - started} ms (photo data ${stripEnabled() ? "left out" : "included"})`);
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

    if (order.customer?.phone) {
      const Customer = require("../models/Customer");
      const normalized = order.customer.phone.replace(/\D/g, "").replace(/^91/, "").slice(-10);
      if (normalized.length >= 6) {
        Customer.findOneAndUpdate(
          { phone: { $regex: normalized + "$" } },
          { phone: normalized, name: order.customer.name, address: order.customer.address, channel: order.channel, lastOrderId: order.id, updatedAt: new Date() },
          { upsert: true, new: true }
        ).catch(() => {});
      }
    }

    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/orders/:id — full order update (handles id rename, records edit log)
//
// IMPORTANT MONGOOSE GOTCHA — read before touching this route again:
// Plain `Object.assign(order, updateData)` followed by `order.save()` does NOT
// reliably persist changes to nested array/subdocument fields like `items`
// (which itself contains nested arrays like `items[].images`). Mongoose's
// dirty-checking can miss these because the assignment doesn't always go through
// the schema-aware setters that mark a path as modified. This previously caused
// product images (and other item-level edits) to appear to save successfully
// — the response looked correct — but silently fail to persist, so the data
// reverted on the next fetch. The fix is to explicitly call markModified() on
// every top-level field that contains nested arrays/objects whenever we touch
// it via Object.assign, every time, no exceptions.
router.put("/:id", auth, async (req, res) => {
  try {
    const { id: newId, editLogEntry, ...rest } = req.body;
    const updateData = { ...rest, updatedAt: new Date() };

    if (newId && newId !== req.params.id) {
      const conflict = await Order.findOne({ id: newId });
      if (conflict) return res.status(409).json({ error: `Order ID ${newId} already exists` });
      updateData.id = newId;
    }

    // Retry up to 3 times on version conflicts — these happen when two saves
    // fire in rapid succession (e.g. image preview save followed immediately
    // by the Cloudinary URL save). Each retry re-fetches the latest document
    // so it picks up the previous save before applying the new changes.
    let order;
    let attempts = 0;
    while (attempts < 3) {
      try {
        order = await Order.findOne({ id: req.params.id });
        if (!order) return res.status(404).json({ error: "Order not found" });

        // SAVE GUARD: the client may hold a copy of this order without its embedded photo data
        // (the list leaves it out). Put the stored data back for any photo that arrives without it,
        // so saving can never erase a photo whose embedded copy is the only copy.
        if (updateData.items !== undefined) {
          const g = restorePhotoData(updateData.items, order);
          if (g.restored || g.absentFromPayload) {
            console.log(`[photo-guard] ${req.params.id}: restored data on ${g.restored} photo(s); ${g.absentFromPayload} stored embedded photo(s) not in the incoming items (treated as deleted)`);
          }
        }

        Object.assign(order, updateData);

        if (updateData.items !== undefined) order.markModified("items");
        if (updateData.payments !== undefined) order.markModified("payments");
        if (updateData.costs !== undefined) order.markModified("costs");
        if (updateData.dispatchDetails !== undefined) order.markModified("dispatchDetails");
        if (updateData.customer !== undefined) order.markModified("customer");
        if (updateData.orderSheetFiles !== undefined) order.markModified("orderSheetFiles");
        if (updateData.status !== undefined) order.markModified("status");
        if (updateData.notes !== undefined) order.markModified("notes");
        if (updateData.deliveryConfirmed !== undefined) order.markModified("deliveryConfirmed");
        if (updateData.costApproved !== undefined) order.markModified("costApproved");
        if (updateData.marginOverride !== undefined) order.markModified("marginOverride");

        // Always append an edit-log entry, even if the frontend didn't supply a
        // specific field label — this is the safety net that makes logging
        // comprehensive. Every mutation to an order (stage changes, QC, photos,
        // order info, notes, etc.) currently goes through this one PUT route from
        // the frontend, so this fallback is what guarantees nothing saves silently.
        {
          if (!order.editLog) order.editLog = [];
          order.editLog.push({
            changedBy: req.user.name || "Unknown",
            field: (editLogEntry && editLogEntry.field) || "Order updated",
            changedAt: new Date(),
          });
          order.markModified("editLog");
        }

        await order.save();
        break;
      } catch (saveErr) {
        if (saveErr.name === "VersionError" && attempts < 2) {
          attempts++;
          continue;
        }
        throw saveErr;
      }
    }

    res.json(clientView(order));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/orders/:id — permanently delete an order (admin only).
// Also removes every Cloudinary file referenced by the order (item images,
// measurement/raw/finishing/QC photos, order sheet files) so deleted orders
// don't leave orphaned files behind in storage. File cleanup runs after the
// order is confirmed to exist but the order delete itself is not blocked on
// it succeeding — a failed Cloudinary cleanup is logged, not fatal, since the
// order record being gone is the priority and storage cleanup can be retried.
router.delete("/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const publicIds = collectPublicIds(order);

    await Order.deleteOne({ id: req.params.id });

    if (publicIds.length > 0) {
      const results = await Promise.allSettled(
        publicIds.map(publicId => cloudinary.uploader.destroy(publicId))
      );
      const failed = results.filter(r => r.status === "rejected").length;
      if (failed > 0) {
        console.error(`Order ${req.params.id} deleted, but ${failed}/${publicIds.length} Cloudinary files failed to delete.`);
      }
    }

    res.json({ success: true, deletedId: req.params.id, filesDeleted: publicIds.length });
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

    if (stageIndex !== undefined) {
      item.stageIndex = stageIndex;
      if (!item.stageHistory) item.stageHistory = [];
      item.stageHistory.push({ stageIndex, enteredAt: new Date() });
    }
    if (finishingProgress !== undefined) item.finishingProgress = finishingProgress;
    if (qcStatus !== undefined) item.qcStatus = qcStatus;
    if (qcNotes !== undefined) item.qcNotes = qcNotes;
    if (packetCount !== undefined) item.packetCount = packetCount;
    order.updatedAt = new Date();
    order.markModified("items");

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
    order.markModified("items");

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
    order.markModified("items");
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
    order.markModified("payments");
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
    order.markModified("items");
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;