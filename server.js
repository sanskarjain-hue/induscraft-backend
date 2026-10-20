require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors({
  origin: [
    "https://induscraft-oms.vercel.app",
    "https://oms.induscraft.com",
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

// ── TEMP: migrate deal stages ─────────────────────────────
app.get("/api/migrate-deal-stages", async (req, res) => {
  if (req.query.secret !== "induscraft2026") return res.status(403).json({ error: "Forbidden" });
  try {
    const Deal = require("./models/Deal");
    const map = { "Lead": "New Inquiry", "Design & Concept": "Warm", "Quoted": "Negotiation" };
    let updated = 0;
    const deals = await Deal.find({});
    for (const deal of deals) {
      if (map[deal.stage]) {
        deal.stage = map[deal.stage];
        await deal.save();
        updated++;
      }
    }
    res.json({ success: true, updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ── END TEMP ──────────────────────────────────────────────

// ── TEMP: fix salesperson name in deals ──────────────────
app.get("/api/fix-sanskar", async (req, res) => {
  if (req.query.secret !== "induscraft2026") return res.status(403).json({ error: "Forbidden" });
  try {
    const Deal = require("./models/Deal");
    const result = await Deal.updateMany({ salesperson: "Sanskar" }, { salesperson: "Sanskar Jain" });
    res.json({ success: true, updated: result.modifiedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ── END TEMP ──────────────────────────────────────────────

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/", (req, res) => {
  // photoGuard: lets the photo-migration script confirm the save guard is live before it changes any data
  res.json({ status: "Induscraft OMS API is running", version: "1.0.0", photoGuard: require("./utils/photoData").GUARD_VERSION });
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