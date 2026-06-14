require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors({
  origin: [
    "https://induscraft-oms.vercel.app",
    "https://ops.induscraft.store",
    "http://localhost:5173",
  ],
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── ROUTES ────────────────────────────────────────────────
app.use("/api/auth", require("./routes/auth"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/vendors", require("./routes/vendors"));
app.use("/api/aftersales", require("./routes/aftersales"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/deals", require("./routes/deals"));
app.use("/api/customers", require("./routes/customers"));

// ── TEMPORARY MIGRATION ROUTE — REMOVE AFTER RUNNING ─────
app.get("/api/migrate-images", async (req, res) => {
  if (req.query.secret !== "induscraft2026") return res.status(403).json({ error: "Forbidden" });
  const cloudinary = require("cloudinary").v2;
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
  const Order = require("./models/Order");
  const FIELDS = ["images", "measurementPhotos", "rawPhotos", "finishingPhotos", "qcPhotos"];
  const results = { total: 0, migrated: 0, skipped: 0, failed: 0, errors: [] };
  try {
    const orders = await Order.find({});
    for (const order of orders) {
      let modified = false;
      for (const item of order.items) {
        for (const field of FIELDS) {
          const photos = item[field] || [];
          for (let i = 0; i < photos.length; i++) {
            const photo = photos[i];
            results.total++;
            if (!photo.data || !photo.data.startsWith("data:") || photo.url) { results.skipped++; continue; }
            try {
              const result = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload(photo.data, { folder: `induscraft/${field}`, resource_type: "auto" }, (err, r) => err ? reject(err) : resolve(r));
              });
              photos[i].url = result.secure_url;
              photos[i].publicId = result.public_id;
              photos[i].data = undefined;
              modified = true;
              results.migrated++;
            } catch (err) {
              results.failed++;
              results.errors.push(`${order.id}/${field}[${i}]: ${err.message}`);
            }
          }
        }
      }
      if (modified) { order.markModified("items"); await order.save(); }
    }
    res.json({ success: true, ...results });
  } catch (err) { res.status(500).json({ error: err.message, ...results }); }
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Induscraft OMS API is running", version: "1.0.0" });
});

// ── MONGODB ───────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

// ── ERROR HANDLER ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || "Server error" });
});